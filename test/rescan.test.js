// server/rescan.js: one scan at a time, but a request that lands mid-scan is
// queued rather than discarded.
//
// Written as a differential test, like test/no-regression.test.js: the guard
// server.js used to carry is reimplemented verbatim below and driven through the
// same scenarios, so every assertion states what changed rather than restating
// the new implementation.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRescan } from '../server/rescan.ts';

// server/server.js before this change.
function oldRescan(scan) {
  let scanning = false;
  return async function rescan() {
    if (scanning) return;
    scanning = true;
    try { await scan(); } finally { scanning = false; }
  };
}

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

// A scan whose completion the test controls. `started` records the config each
// scan read AT ITS START, which is the whole question here.
function gated() {
  const waiting = [];
  const started = [];
  return {
    started,
    async run(tag) { started.push(tag); await new Promise((r) => waiting.push(r)); },
    release() { const r = waiting.shift(); if (r) r(); },
    get pending() { return waiting.length; },
  };
}

// The shape of POST /api/settings: replace baseDirs, then `await rescan()`.
function scenario(make) {
  const g = gated();
  let baseDirs = ['a'];
  const rescan = make(async () => { const dirs = baseDirs.join(','); await g.run(dirs); });
  return { g, rescan, setBaseDirs: (v) => { baseDirs = v; } };
}

test('a baseDirs change made during a scan gets its own scan', async () => {
  const now = scenario(createRescan);
  const before = scenario(oldRescan);

  for (const s of [now, before]) {
    const first = s.rescan();           // a background scan is already in flight …
    await tick();
    s.setBaseDirs(['a', 'b']);          // … when POST /api/settings replaces baseDirs
    const queued = s.rescan();
    s.g.release();                      // the in-flight scan finishes — it only saw ['a']
    await first;
    await tick();
    s.g.release();
    await queued;
    await tick();
  }

  assert.deepEqual(now.g.started, ['a', 'a,b'], 'the queued request ran, and read the NEW baseDirs');
  assert.deepEqual(before.g.started, ['a'], 'the old guard dropped it — nothing would ever re-trigger it');
});

test('several requests during one scan collapse into a single follow-up', async () => {
  const g = gated();
  const rescan = createRescan(() => g.run(g.started.length));
  const first = rescan();
  await tick();
  const queued = [rescan(), rescan(), rescan()];
  assert.equal(queued[0], queued[1], 'they share one promise');
  assert.equal(queued[1], queued[2]);
  g.release(); await first; await tick();
  g.release(); await Promise.all(queued); await tick();
  assert.equal(g.started.length, 2, 'three mid-scan requests bought exactly one re-run');
  assert.equal(g.pending, 0);
});

test('sequential requests do not stack up', async () => {
  const g = gated();
  const rescan = createRescan(() => g.run('x'));
  for (let i = 0; i < 3; i++) { const p = rescan(); await tick(); g.release(); await p; }
  assert.equal(g.started.length, 3);
  assert.equal(g.pending, 0);
});

test('a failed scan neither wedges the queue nor swallows the next caller\'s result', async () => {
  let n = 0;
  const rescan = createRescan(async () => { n += 1; if (n === 1) throw new Error('scan blew up'); });
  await assert.rejects(rescan(), /scan blew up/, 'the first caller still sees their own failure');
  await rescan();
  assert.equal(n, 2, 'the next request runs a fresh scan');
  await rescan();
  assert.equal(n, 3);
});
