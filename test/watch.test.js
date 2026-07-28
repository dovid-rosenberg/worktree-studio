// Driven against real temp git repos and real fs.watch — the whole point of this
// module is the behaviour of the filesystem under actual git commands, which a
// mock would only re-state our assumptions about.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import * as watch from '../server/watch.ts';
import * as worktree from '../server/worktree.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 6000, label = 'condition' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

function tempBase() {
  // realpath so the paths we assert on match the ones walkTree builds (/var → /private/var)
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wts-watch-')));
}

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  return dir;
}

// Intervals that keep the periodic jobs out of the way so a test measures only
// what the filesystem watches did. Individual tests override what they exercise.
const QUIET = {
  tickMs: 20,
  debounceMs: 250,
  maxDebounceMs: 5000,
  minRescanMs: 0,
  netActiveMs: 3600000,
  netIdleMs: 3600000,
  runningActiveMs: 3600000,
  runningIdleMs: 3600000,
  reconcileActiveMs: 3600000,
  reconcileIdleMs: 3600000,
};

// Boots a watcher over `base` with a counting rescan. Returns the handle plus the
// call log; the initial (awaited) boot scan is zeroed out so tests count only
// what their own actions caused.
/**
 * @param {string} base
 * @param {{ intervals?: object, rescan?: Function, [dep: string]: any }} [opts]
 */
async function boot(base, { intervals = {}, rescan, ...deps } = {}) {
  const calls = [];
  const h = await watch.start({
    cfg: { baseDirs: [base], scanDepth: 3 },
    rescan: rescan || (async () => { calls.push(Date.now()); }),
    intervals: { ...QUIET, ...intervals },
    ...deps,
  });
  // fs.watch returns before macOS has actually started the FSEvents stream, so a
  // change made in the first few milliseconds can be missed. That is inherent to
  // fs.watch (and why the safety-net timer exists); give the streams a moment so
  // the tests measure our filtering and debouncing rather than that race.
  await sleep(150);
  calls.length = 0;
  return { h, calls };
}

test('a worktree add collapses git\'s burst of writes into exactly one rescan', async (t) => {
  const base = tempBase();
  const repo = makeRepo(path.join(base, 'alpha'));
  const { h, calls } = await boot(base);
  t.after(() => { h.stop(); fs.rmSync(base, { recursive: true, force: true }); });

  const out = await worktree.create(repo, 'feature/watched', 'watched', { fetch: false });
  assert.equal(out.ok, true, out.error);

  await waitFor(() => calls.length >= 1, { label: 'a rescan after worktree add' });
  await sleep(600); // long enough for a second debounce window to have elapsed
  assert.equal(calls.length, 1, `one rescan for one worktree add, got ${calls.length}`);
});

test('a worktree remove triggers a rescan', async (t) => {
  const base = tempBase();
  const repo = makeRepo(path.join(base, 'alpha'));
  const out = await worktree.create(repo, 'feature/gone', 'gone', { fetch: false });
  assert.equal(out.ok, true, out.error);

  const { h, calls } = await boot(base);
  t.after(() => { h.stop(); fs.rmSync(base, { recursive: true, force: true }); });

  const rm = await worktree.remove(repo, out.path);
  assert.equal(rm.ok, true, rm.error);
  await waitFor(() => calls.length >= 1, { label: 'a rescan after worktree remove' });
  await sleep(600);
  assert.equal(calls.length, 1, `one rescan for one worktree remove, got ${calls.length}`);
});

test('a commit triggers a rescan (the merged/ahead computation reads refs)', async (t) => {
  const base = tempBase();
  const repo = makeRepo(path.join(base, 'alpha'));
  const { h, calls } = await boot(base);
  t.after(() => { h.stop(); fs.rmSync(base, { recursive: true, force: true }); });

  fs.writeFileSync(path.join(repo, 'next.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'second'], { cwd: repo, stdio: 'ignore' });
  await waitFor(() => calls.length >= 1, { label: 'a rescan after a commit' });
});

test('ordinary churn — working-tree saves and git index writes — triggers no rescan', async (t) => {
  const base = tempBase();
  const repo = makeRepo(path.join(base, 'alpha'));
  const { h, calls } = await boot(base);
  t.after(() => { h.stop(); fs.rmSync(base, { recursive: true, force: true }); });

  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(repo, 'src', 'deep', `f${i}.js`), `// ${i}\n`);
  execFileSync('git', ['status'], { cwd: repo, stdio: 'ignore' }); // rewrites .git/index
  execFileSync('git', ['status'], { cwd: repo, stdio: 'ignore' });

  await sleep(900);
  assert.equal(calls.length, 0, `no rescan for source edits or index churn, got ${calls.length}`);
});

test('a repo appearing under a baseDir triggers a rescan and gets watched', async (t) => {
  const base = tempBase();
  makeRepo(path.join(base, 'alpha'));
  const staging = tempBase();
  const built = makeRepo(path.join(staging, 'beta'));
  const { h, calls } = await boot(base);
  t.after(() => { h.stop(); fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(staging, { recursive: true, force: true }); });

  const landed = path.join(base, 'beta');
  fs.renameSync(built, landed); // appears fully-formed, like a finished clone/move

  await waitFor(() => calls.length >= 1, { label: 'a rescan for the new repo' });
  await waitFor(() => h.watched().includes(path.join(landed, '.git')), { label: 'the new repo to be watched' });
});

test('watchers are released when a repo disappears', async (t) => {
  const base = tempBase();
  makeRepo(path.join(base, 'alpha'));
  const doomed = makeRepo(path.join(base, 'beta'));
  const { h, calls } = await boot(base);
  t.after(() => { h.stop(); fs.rmSync(base, { recursive: true, force: true }); });

  assert.ok(h.watched().some((p) => p.startsWith(doomed + path.sep)), 'the doomed repo starts out watched');
  const before = h.stats().watchers;

  fs.rmSync(doomed, { recursive: true, force: true });

  await waitFor(() => calls.length >= 1, { label: 'a rescan after the repo was removed' });
  await waitFor(() => !h.watched().some((p) => p.startsWith(doomed + path.sep)), { label: 'the dead watchers to be pruned' });
  assert.ok(h.stats().watchers < before, `watcher count fell (${before} → ${h.stats().watchers})`);
});

test('stop() releases every watcher and stops responding to events', async (t) => {
  const base = tempBase();
  const repo = makeRepo(path.join(base, 'alpha'));
  const { h, calls } = await boot(base);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  assert.ok(h.stats().watchers > 0, 'watchers were armed');
  h.stop();
  assert.equal(h.stats().watchers, 0, 'every watcher released');

  await worktree.create(repo, 'feature/after-stop', 'after-stop', { fetch: false });
  await sleep(700);
  assert.equal(calls.length, 0, 'a stopped watcher rescans nothing');
});

test('rescans never overlap; events arriving mid-scan collapse into one follow-up', async (t) => {
  const base = tempBase();
  const repo = makeRepo(path.join(base, 'alpha'));
  let live = 0;
  let maxLive = 0;
  let done = 0;
  const { h } = await boot(base, {
    intervals: { debounceMs: 40, maxDebounceMs: 200 },
    rescan: async () => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      await sleep(250);
      live -= 1;
      done += 1;
    },
  });
  t.after(() => { h.stop(); fs.rmSync(base, { recursive: true, force: true }); });

  // Twelve real ref writes spread across the whole of a scan and then some.
  for (let i = 0; i < 12; i++) {
    execFileSync('git', ['branch', '-f', `b${i}`, 'HEAD'], { cwd: repo, stdio: 'ignore' });
    await sleep(60);
  }
  await waitFor(() => done >= 1 && live === 0, { label: 'the scans to drain' });
  await sleep(500);
  // The hard guarantee: server.js's `scanning` guard drops overlapping calls, so a
  // second scan must never be issued while one is in flight.
  assert.equal(maxLive, 1, `never more than one scan in flight, saw ${maxLive}`);
  // …and every event that landed during a scan collapsed into a single follow-up
  // rather than queueing one scan each (12 writes ⇒ ~4 scans, not 12).
  assert.ok(done >= 1 && done <= 6, `events mid-scan coalesced (${done} scans for 12 ref writes)`);
});

test('the dev-server sweep backs off while no dashboard is attached, and catches up when one opens', async (t) => {
  const base = tempBase();
  makeRepo(path.join(base, 'alpha'));
  let viewers = false;
  let sweeps = 0;
  const { h } = await boot(base, {
    intervals: { tickMs: 15, runningActiveMs: 40, runningIdleMs: 3600000 },
    refreshRunning: async () => { sweeps += 1; },
    hasViewers: () => viewers,
  });
  t.after(() => { h.stop(); fs.rmSync(base, { recursive: true, force: true }); });

  assert.equal(sweeps, 1, 'boot primes the sweep exactly once (as the old boot did)');
  await sleep(400);
  assert.equal(sweeps, 1, 'no further sweeps while nobody is looking');

  viewers = true;
  await waitFor(() => sweeps >= 4, { label: 'sweeps to resume once a dashboard attaches' });
});

test('attention counts a poll as much as an open stream, and forgets a stale one', async () => {
  const streamed = watch.attention({ streams: () => 1, pollWindowMs: 60 });
  assert.equal(streamed.active(), true, 'an open SSE stream is enough on its own');

  // SwiftBar and Alfred never open a stream — they curl /api/state and exit.
  const polled = watch.attention({ streams: () => 0, pollWindowMs: 60 });
  assert.equal(polled.active(), false, 'nothing is looking yet');
  polled.seen();
  assert.equal(polled.active(), true, 'a bare poll counts as looking');
  await sleep(140);
  assert.equal(polled.active(), false, 'and stops counting once the window lapses');

  const bare = watch.attention();
  bare.seen();
  assert.equal(bare.active(), true, 'works with no stream source wired at all');

  const broken = watch.attention({ streams: () => { throw new Error('nope'); } });
  assert.equal(broken.active(), true, 'a throwing probe never silently drops us to idle');
});

test('a bare /api/state poll with no SSE client keeps the dev-server sweep fast', async (t) => {
  const base = tempBase();
  makeRepo(path.join(base, 'alpha'));
  // The menubar-only steady state: browser closed (no streams), SwiftBar polling.
  // Real cadence is a 10s poll inside a 30s window; scaled down 100x here.
  const att = watch.attention({ streams: () => 0, pollWindowMs: 300 });
  let sweeps = 0;
  const { h } = await boot(base, {
    intervals: { tickMs: 15, runningActiveMs: 40, runningIdleMs: 3600000 },
    refreshRunning: async () => { sweeps += 1; },
    hasViewers: att.active,
  });
  t.after(() => { h.stop(); fs.rmSync(base, { recursive: true, force: true }); });

  const quiet = sweeps;
  await sleep(300);
  assert.equal(sweeps, quiet, 'idle cadence while genuinely nothing is polling');

  const menubar = setInterval(() => att.seen(), 100); // SwiftBar wakes up
  t.after(() => clearInterval(menubar));
  await waitFor(() => sweeps >= quiet + 4, { label: 'the sweep to stay fast while the menubar polls' });

  clearInterval(menubar); // SwiftBar stops (screen locked, Studio quit from the menu…)
  await sleep(400); // outlive the poll window
  const settled = sweeps;
  await sleep(300);
  assert.equal(sweeps, settled, 'back to the idle cadence once nothing is polling');
});

test('reconcile is left alone at boot so restore() can still bring sessions back', async (t) => {
  const base = tempBase();
  makeRepo(path.join(base, 'alpha'));
  let reconciles = 0;
  const { h } = await boot(base, {
    intervals: { tickMs: 15, reconcileActiveMs: 400, reconcileIdleMs: 3600000 },
    reconcile: async () => { reconciles += 1; },
    hasViewers: () => true,
  });
  t.after(() => { h.stop(); fs.rmSync(base, { recursive: true, force: true }); });

  assert.equal(reconciles, 0, 'not run during start() — its first run is a full interval away');
  await waitFor(() => reconciles >= 1, { label: 'reconcile to run on the tick' });
});

test('the safety net still rescans when the filesystem said nothing at all', async (t) => {
  const base = tempBase();
  makeRepo(path.join(base, 'alpha'));
  const { h, calls } = await boot(base, { intervals: { tickMs: 15, netActiveMs: 60, netIdleMs: 3600000 }, hasViewers: () => true });
  t.after(() => { h.stop(); fs.rmSync(base, { recursive: true, force: true }); });

  await waitFor(() => calls.length >= 2, { label: 'the safety-net rescans' });
});

test('a failing rescan does not take the watcher down', async (t) => {
  const base = tempBase();
  const repo = makeRepo(path.join(base, 'alpha'));
  let attempts = 0;
  const { h } = await boot(base, {
    intervals: { debounceMs: 40, maxDebounceMs: 200 },
    rescan: async () => { attempts += 1; throw new Error('scan blew up'); },
  });
  t.after(() => { h.stop(); fs.rmSync(base, { recursive: true, force: true }); });

  execFileSync('git', ['branch', '-f', 'one', 'HEAD'], { cwd: repo, stdio: 'ignore' });
  await waitFor(() => attempts >= 1, { label: 'the first (throwing) rescan' });
  await sleep(300);
  execFileSync('git', ['branch', '-f', 'two', 'HEAD'], { cwd: repo, stdio: 'ignore' });
  await waitFor(() => attempts >= 2, { label: 'the watcher to keep working after a throw' });
});
