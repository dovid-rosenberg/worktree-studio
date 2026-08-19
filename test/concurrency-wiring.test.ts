// Integration wiring for running 2–3 features concurrently, on the `Servers` class:
// the slot registry (allocSlotFor/releaseSlot), the derived launch env/ports/patch
// descriptor (launchOpts), and the on-disk FE-config rewrite (applyConfigPatch).
// The pure helpers in concurrency.ts are covered separately in concurrency.test.js;
// here we exercise how Servers wires them together. No child processes are spawned.
import { test } from 'node:test';
import assert from 'node:assert';
import { expectOk, present } from './helpers.ts';
import type { ConcurrencyConfig } from '../server/types.ts';
import type { ConfigPatchPlan } from '../server/servers.ts';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Servers, featureFromPath, realpath } from '../server/servers.ts';
import { validateConcurrency } from '../server/config.ts';

// accept-blue's real port map + FE configPatch wiring — mirrors config.ts defaults.
const AB_PORT_ENV = {
  api__port_su: 1231,
  api__port_iso: 1232,
  api__port: 1233,
  api__port_merchant: 1239,
  api__port_internal: 1999,
};
function concurrency(overrides = {}) {
  return {
    enabled: true,
    offsetStep: 100,
    maxSlots: 3,
    repos: {
      'accept-blue': { portEnv: { ...AB_PORT_ENV }, slotEnv: ['redis__db'] },
      'merchant-v3': {
        portEnv: { WTS_FE_PORT: 3030 },
        configPatch: { file: 'src/config.ts', siblingRepo: 'accept-blue' },
      },
    },
    ...overrides,
  };
}

// Build a real Servers with a throwaway state dir (constructor makes logs/ + locks/).
function servers(concOverrides = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-conc-'));
  const cfg = {
    _stateDir: stateDir,
    web: { port: 0 },
    start: {},
    concurrency: concurrency(concOverrides),
  };
  return new Servers(cfg);
}

// ---------------------------------------------------------------------------
// Slot registry: allocSlotFor / releaseSlot
// ---------------------------------------------------------------------------

test('allocSlotFor gives the first feature slot 0', async () => {
  const s = servers();
  assert.deepEqual(await s.allocSlotFor('feat-a'), { slot: 0 });
});

test('allocSlotFor gives a second, different feature slot 1', async () => {
  const s = servers();
  await s.allocSlotFor('feat-a');
  assert.deepEqual(await s.allocSlotFor('feat-b'), { slot: 1 });
});

test('allocSlotFor gives a third distinct feature slot 2', async () => {
  const s = servers();
  await s.allocSlotFor('feat-a');
  await s.allocSlotFor('feat-b');
  assert.deepEqual(await s.allocSlotFor('feat-c'), { slot: 2 });
});

test('allocSlotFor returns the same cached slot when a feature is asked twice', async () => {
  const s = servers();
  await s.allocSlotFor('feat-a'); // 0
  await s.allocSlotFor('feat-b'); // 1
  assert.deepEqual(await s.allocSlotFor('feat-a'), { slot: 0 }, 'reuses the cached slot, does not re-allocate');
  // feat-a asked again must NOT consume slot 2
  assert.deepEqual(await s.allocSlotFor('feat-c'), { slot: 2 });
});

test('allocSlotFor returns an error shape when maxSlots (3) is exhausted', async () => {
  const s = servers();
  await s.allocSlotFor('feat-a'); // 0
  await s.allocSlotFor('feat-b'); // 1
  await s.allocSlotFor('feat-c'); // 2
  const out = await s.allocSlotFor('feat-d');
  assert.equal(out.slot, undefined, 'no slot handed out');
  assert.match(present(out.error, 'a refusal'), /no free concurrency slot/);
});

test('releaseSlot frees the slot so a new feature reuses the lowest freed slot', async () => {
  const s = servers();
  await s.allocSlotFor('feat-a'); // 0
  await s.allocSlotFor('feat-b'); // 1
  await s.allocSlotFor('feat-c'); // 2
  s.releaseSlot('feat-b'); // frees slot 1
  assert.deepEqual(await s.allocSlotFor('feat-new'), { slot: 1 }, 'reuses the lowest freed slot');
});

test('allocSlotFor returns slot 0 for any feature when concurrency is disabled', async () => {
  const s = servers({ enabled: false });
  assert.deepEqual(await s.allocSlotFor('feat-a'), { slot: 0 });
  assert.deepEqual(await s.allocSlotFor('feat-b'), { slot: 0 }, 'no real allocation happens');
  assert.equal(s.slots.size, 0, 'slot registry stays empty when disabled');
});

// ---------------------------------------------------------------------------
// launchOpts(repo, feature)
// ---------------------------------------------------------------------------

test('launchOpts returns empty env/ports when concurrency is disabled', async () => {
  const s = servers({ enabled: false });
  assert.deepEqual(s.launchOpts('accept-blue', 'feat-a'), { env: {}, ports: [] });
});

test('launchOpts for accept-blue at slot 0 yields base ports and redis__db 0', async () => {
  const s = servers();
  await s.allocSlotFor('feat-a'); // slot 0
  const opts = s.launchOpts('accept-blue', 'feat-a');
  assert.deepEqual(opts.env, {
    api__port_su: '1231',
    api__port_iso: '1232',
    api__port: '1233',
    api__port_merchant: '1239',
    api__port_internal: '1999',
    redis__db: '0',
  });
  assert.deepEqual(opts.ports, [1231, 1232, 1233, 1239, 1999]);
  assert.equal(opts.patch, undefined, 'accept-blue itself has no configPatch');
});

test('launchOpts for accept-blue at slot 2 shifts every port +200 and sets redis__db 2', async () => {
  const s = servers();
  await s.allocSlotFor('feat-a'); // 0
  await s.allocSlotFor('feat-b'); // 1
  await s.allocSlotFor('feat-c'); // 2
  const opts = s.launchOpts('accept-blue', 'feat-c');
  assert.deepEqual(opts.env, {
    api__port_su: '1431',
    api__port_iso: '1432',
    api__port: '1433',
    api__port_merchant: '1439',
    api__port_internal: '2199',
    redis__db: '2',
  });
  assert.deepEqual(opts.ports, [1431, 1432, 1433, 1439, 2199]);
});

test('launchOpts returns empty env/ports for a repo not in concurrency.repos', async () => {
  const s = servers();
  await s.allocSlotFor('feat-a');
  assert.deepEqual(s.launchOpts('some-unconfigured-repo', 'feat-a'), { env: {}, ports: [] });
});

test('launchOpts for a repo with a configPatch returns a patch descriptor resolving the sibling ports and slot', async () => {
  const s = servers();
  await s.allocSlotFor('feat-a'); // 0
  await s.allocSlotFor('feat-b'); // 1
  const opts = s.launchOpts('merchant-v3', 'feat-b'); // slot 1
  const patch = present(opts.patch, 'a config patch');
  assert.equal(patch.file, 'src/config.ts');
  assert.deepEqual(patch.siblingPortEnv, AB_PORT_ENV, "resolves to accept-blue's portEnv");
  assert.equal(patch.slot, 1, "patch slot matches the feature's slot");
  // its own env is the FE port shifted by its slot
  assert.deepEqual(opts.env, { WTS_FE_PORT: '3130' });
  assert.deepEqual(opts.ports, [3130]);
});

// ---------------------------------------------------------------------------
// applyConfigPatch(worktreePath, patch) — real temp worktree dir + config file
// ---------------------------------------------------------------------------

function worktreeWithConfig(relFile: string, contents: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-wt-'));
  const file = path.join(dir, relFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return { dir, file };
}

const FE_CONFIG = [
  'export default {',
  "  suURL: 'http://localhost:1231/su/api/v1',",
  "  merchantURL: 'http://localhost:1239/merchant',",
  "  isoURL: 'http://localhost:1232/iso/api/v1',",
  "  fePort: 'http://localhost:3030',",
  '};',
  '',
].join('\n');

test('applyConfigPatch at slot 2 rewrites every sibling localhost:port +200 and leaves other text untouched', async () => {
  const s = servers();
  const { dir, file } = worktreeWithConfig('src/config.ts', FE_CONFIG);
  s.applyConfigPatch(dir, { file: 'src/config.ts', siblingPortEnv: AB_PORT_ENV, slot: 2 });
  const expected = [
    'export default {',
    "  suURL: 'http://localhost:1431/su/api/v1',",
    "  merchantURL: 'http://localhost:1439/merchant',",
    "  isoURL: 'http://localhost:1432/iso/api/v1',",
    "  fePort: 'http://localhost:3030',", // FE's own vite port — not a sibling family
    '};',
    '',
  ].join('\n');
  assert.equal(fs.readFileSync(file, 'utf8'), expected);
});

test('applyConfigPatch at slot 0 leaves the file byte-for-byte unchanged', async () => {
  const s = servers();
  const { dir, file } = worktreeWithConfig('src/config.ts', FE_CONFIG);
  s.applyConfigPatch(dir, { file: 'src/config.ts', siblingPortEnv: AB_PORT_ENV, slot: 0 });
  assert.equal(fs.readFileSync(file, 'utf8'), FE_CONFIG);
});

test('applyConfigPatch is idempotent (running the same patch twice yields the same result)', async () => {
  const s = servers();
  const { dir, file } = worktreeWithConfig('src/config.ts', FE_CONFIG);
  const patch = { file: 'src/config.ts', siblingPortEnv: AB_PORT_ENV, slot: 2 };
  s.applyConfigPatch(dir, patch);
  const once = fs.readFileSync(file, 'utf8');
  s.applyConfigPatch(dir, patch);
  assert.equal(fs.readFileSync(file, 'utf8'), once);
});

test('applyConfigPatch is a no-op (no throw) when the config file is absent', async () => {
  const s = servers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-wt-'));
  assert.doesNotThrow(() =>
    s.applyConfigPatch(dir, { file: 'src/config.ts', siblingPortEnv: AB_PORT_ENV, slot: 2 }),
  );
  assert.ok(!fs.existsSync(path.join(dir, 'src/config.ts')), 'no file was created');
});

test('applyConfigPatch is a no-op when the patch descriptor is missing a file', async () => {
  const s = servers();
  assert.doesNotThrow(() => s.applyConfigPatch('/nonexistent', null));
  // A descriptor with no `file` is the case under test, so it is cast in deliberately:
  // a hand-edited config.json can produce one and applyConfigPatch must shrug.
  assert.doesNotThrow(() => s.applyConfigPatch('/nonexistent', {} as ConfigPatchPlan));
});

// ---------------------------------------------------------------------------
// Backward-compat: concurrency off == today's base ENV / base ports
// ---------------------------------------------------------------------------

test('with concurrency disabled, launchOpts for accept-blue returns empty env so start() uses base ENV/ports', async () => {
  const s = servers({ enabled: false });
  await s.allocSlotFor('feat-a');
  const opts = s.launchOpts('accept-blue', 'feat-a');
  assert.deepEqual(opts, { env: {}, ports: [] });
});

// ---------------------------------------------------------------------------
// A1 — slot map is persisted to servers.json and reconstructed on restart
// ---------------------------------------------------------------------------

// Build a Servers on a caller-owned stateDir so a second instance can reuse it.
function serversOn(stateDir: string, concOverrides: Partial<ConcurrencyConfig> = {}) {
  return new Servers({
    _stateDir: stateDir,
    web: { port: 0 },
    start: {},
    concurrency: concurrency(concOverrides),
  });
}

test('A1: slots survive a Studio restart (new Servers on the same stateDir restores them)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-persist-'));
  const s1 = serversOn(stateDir);
  await s1.allocSlotFor('feat-a'); // 0
  await s1.allocSlotFor('feat-b'); // 1
  const s2 = serversOn(stateDir); // simulate a restart
  assert.equal(s2.slots.get('feat-a'), 0);
  assert.equal(s2.slots.get('feat-b'), 1);
  assert.equal(s2.slots.size, 2);
});

test('A1: releaseSlot is durable (a restart sees the freed slot gone)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-persist-'));
  const s1 = serversOn(stateDir);
  await s1.allocSlotFor('feat-a'); // 0
  await s1.allocSlotFor('feat-b'); // 1
  s1.releaseSlot('feat-a');
  const s2 = serversOn(stateDir);
  assert.equal(s2.slots.has('feat-a'), false);
  assert.equal(s2.slots.get('feat-b'), 1);
});

test('A1: an old flat servers.json (just a tracked object) still loads as tracked with empty slots', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-oldfile-'));
  const flat = { '/some/worktree/path': { pid: 123, repo: 'accept-blue', log: '/x.log' } };
  fs.writeFileSync(path.join(stateDir, 'servers.json'), JSON.stringify(flat));
  const s = serversOn(stateDir);
  assert.deepEqual(s.tracked, flat, 'old flat file loads as tracked');
  assert.equal(s.slots.size, 0, 'no slots in an old flat file');
});

test('A1: the persisted file uses the { tracked, slots } shape', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-shape-'));
  const s = serversOn(stateDir);
  await s.allocSlotFor('feat-a');
  const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, 'servers.json'), 'utf8'));
  assert.ok(onDisk.tracked && typeof onDisk.tracked === 'object', 'has a tracked object');
  assert.deepEqual(onDisk.slots, { 'feat-a': 0 }, 'has the slots map');
});

// ---------------------------------------------------------------------------
// A1/A5 — reconcileSlots drops slots whose feature has no running worktree
// ---------------------------------------------------------------------------

test('A5: reconcileSlots keeps features that are running and drops the rest', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-reconcile-'));
  const s = serversOn(stateDir);
  await s.allocSlotFor('feat-x'); // 0
  await s.allocSlotFor('feat-y'); // 1
  // feat-x has a running worktree; feat-y does not.
  const running = new Map([['/repo/.worktrees/feat-x', { pid: 1, ports: [1233] }]]);
  s.reconcileSlots(running);
  assert.equal(s.slots.has('feat-x'), true, 'running feature kept');
  assert.equal(s.slots.has('feat-y'), false, 'stale feature released');
  // and it's durable
  const s2 = serversOn(stateDir);
  assert.equal(s2.slots.has('feat-x'), true);
  assert.equal(s2.slots.has('feat-y'), false);
});

test('A5: reconcileSlots with nothing running clears every slot', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-reconcile-'));
  const s = serversOn(stateDir);
  await s.allocSlotFor('feat-x');
  s.reconcileSlots(new Map());
  assert.equal(s.slots.size, 0);
});

// ---------------------------------------------------------------------------
// A4 — start lock is per-worktree, not per-repo
// ---------------------------------------------------------------------------

test('A4: two different worktrees of the same repo both acquire their locks', async () => {
  const s = servers();
  const pathA = '/repo/.worktrees/feat-a';
  const pathB = '/repo/.worktrees/feat-b';
  const lockA = s._lock(pathA);
  const lockB = s._lock(pathB);
  assert.ok(lockA, 'worktree A acquired its lock');
  assert.ok(lockB, 'worktree B acquired its lock (same repo, different worktree)');
  assert.notEqual(lockA, lockB, 'distinct worktrees get distinct locks');
  s._unlock(lockA);
  s._unlock(lockB);
});

test('A4: a second lock on the SAME worktree fails until released', async () => {
  const s = servers();
  const p = '/repo/.worktrees/feat-a';
  const first = s._lock(p);
  assert.ok(first, 'first lock acquired');
  assert.equal(s._lock(p), null, 'second lock on the same worktree is refused');
  s._unlock(first);
  const again = s._lock(p);
  assert.ok(again, 'lock is re-acquirable after unlock');
  s._unlock(again);
});

// ---------------------------------------------------------------------------
// A8 — validateConcurrency flags footguns (non-fatal warnings) and passes shipped config
// ---------------------------------------------------------------------------

// Capture console.warn calls for the duration of fn.
function captureWarn(fn: () => void): string[] {
  const orig = console.warn;
  const msgs: string[] = [];
  console.warn = (...a: unknown[]) => msgs.push(a.map(String).join(' '));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return msgs;
}

const SHIPPED = {
  enabled: true,
  offsetStep: 100,
  maxSlots: 3,
  repos: { 'accept-blue': { portEnv: { ...AB_PORT_ENV }, slotEnv: ['redis__db'] } },
};

test('A8: the shipped config (step 100, maxSlots 3) produces no warnings', async () => {
  const msgs = captureWarn(() => validateConcurrency({ concurrency: SHIPPED }));
  assert.deepEqual(msgs, []);
});

test('A8: maxSlots 17 is flagged (exceeds the redis DB index limit)', async () => {
  const msgs = captureWarn(() => validateConcurrency({ concurrency: { ...SHIPPED, maxSlots: 17 } }));
  assert.ok(
    msgs.some((m) => /maxSlots=17/.test(m)),
    `expected a maxSlots warning, got: ${JSON.stringify(msgs)}`,
  );
});

test('A8: a colliding offsetStep (step 1) is flagged for the accept-blue port family', async () => {
  const msgs = captureWarn(() => validateConcurrency({ concurrency: { ...SHIPPED, offsetStep: 1 } }));
  assert.ok(
    msgs.some((m) => /collide/.test(m)),
    `expected a collision warning, got: ${JSON.stringify(msgs)}`,
  );
});

test('A8: a disabled concurrency block is never validated', async () => {
  const msgs = captureWarn(() =>
    validateConcurrency({ concurrency: { ...SHIPPED, enabled: false, maxSlots: 99 } }),
  );
  assert.deepEqual(msgs, []);
});

// ---------------------------------------------------------------------------
// Orphan-on-delete: stopping a tracked server frees its slot (DELETE-route semantics)
// ---------------------------------------------------------------------------

test('orphan cleanup: stop() drops the tracked entry and releaseSlot frees the feature slot', async () => {
  const s = servers();
  s.portPid = async () => null; // no real lsof
  s.alive = () => false; // don't signal a made-up pid
  const wt = '/repo/.worktrees/feat-a';
  s.tracked[wt] = { pid: 999999, repo: 'accept-blue', log: '/x.log' };
  await s.allocSlotFor(featureFromPath(wt));
  assert.equal(s.slots.has('feat-a'), true, 'slot allocated for the feature');

  const r = await s.stop('accept-blue', wt);
  assert.equal(r.ok, true);
  assert.equal(s.tracked[wt], undefined, 'tracked entry removed (server not orphaned)');

  s.releaseSlot(featureFromPath(wt));
  assert.equal(s.slots.has('feat-a'), false, 'concurrency slot released (not leaked)');
});

/*
 * A server that DRIFTED off its slot can still be stopped.
 *
 * The sweep derived its port list from the slot the worktree is supposed to be on, so a
 * server sitting on some other slot's ports was unreachable by the only thing that owns
 * it: stop() probed 1231-1999, found nothing, and reported success while the process
 * went on holding 1431-1439 — the ports the feature that DOES hold that slot needs.
 * Observed live: a restart then produced two backends for one worktree, the newer one on
 * the right ports and the older one squatting a neighbour's, answering its API calls
 * from the wrong branch.
 *
 * decorate() already knows where a server really is — that is what `offSlot` reports —
 * so the caller passes those ports in rather than stop() running a discovery scan of its
 * own. Where it should be, plus where it is.
 */
test('stop() sweeps the ports a drifted server is actually on, not only its slot', async () => {
  const s = servers();
  s.alive = () => false;
  const probed: number[] = [];
  s.portPid = async (p: number) => {
    probed.push(p);
    return null;
  };
  await s.allocSlotFor('feat-a'); // slot 0 → 1231…1999
  // What discovery saw: slot 2's ports, held by a server whose cwd is this worktree.
  await s.stop('accept-blue', '/repo/.worktrees/feat-a', [1431, 1439]);
  assert.ok(probed.includes(1439), 'the port it drifted onto is swept');
  assert.ok(probed.includes(1231), "and the slot's own ports still are");
});

test('drifted ports are swept once, even when they overlap the slot', async () => {
  const s = servers();
  s.alive = () => false;
  const probed: number[] = [];
  s.portPid = async (p: number) => {
    probed.push(p);
    return null;
  };
  await s.allocSlotFor('feat-a');
  // A server on SOME of its slot ports and one stray: the overlap must not double-probe,
  // because each probe is an lsof and the sweep runs on every stop.
  await s.stop('accept-blue', '/repo/.worktrees/feat-a', [1231, 1239, 4000]);
  assert.equal(new Set(probed).size, probed.length, 'no port probed twice');
  assert.ok(probed.includes(4000));
});

test("stop() targets only the worktree's known ports (no full discovery scan)", async () => {
  const s = servers();
  s.alive = () => false;
  const probed: number[] = [];
  s.portPid = async (p: number) => {
    probed.push(p);
    return null;
  };
  // accept-blue at slot 0 → its base port family
  await s.allocSlotFor('feat-a');
  await s.stop('accept-blue', '/repo/.worktrees/feat-a');
  assert.deepEqual(
    probed.sort((a, b) => a - b),
    [1231, 1232, 1233, 1239, 1999],
    "probes just this worktree's ports",
  );
});

// ---------------------------------------------------------------------------
// discoverRunning per-pid cache — resolve each pid once, reuse across scans
// ---------------------------------------------------------------------------

// The cache is validated against each process's start time, so a scan needs `ps` to
// answer for these invented pids. One stamp per pid, unchanging: the same process.
function stampPids(s: Servers, startedAt: (pid: number) => number = () => 1_700_000_000_000) {
  s._psInfo = async (pid: number) => ({ startedAt: startedAt(pid), command: `pid-${pid}` });
}

test('discoverRunning resolves each listening pid once and reuses it on the next scan', async () => {
  const s = servers();
  s._listeningPids = async () =>
    new Map([
      ['100', new Set([3000])],
      ['200', new Set([4000])],
    ]);
  stampPids(s);
  let calls = 0;
  s._resolvePid = async (pid) => {
    calls++;
    return { cwd: `/cwd/${pid}`, top: `/top/${pid}` };
  };

  const a = await s.discoverRunning();
  const b = await s.discoverRunning();
  assert.equal(calls, 2, 'each pid resolved once; the second scan is served from cache');
  assert.deepEqual([...a.keys()].sort(), ['/top/100', '/top/200']);
  assert.deepEqual(a.get('/top/100'), { pid: 100, ports: [3000] });
  assert.deepEqual(b, a, 'identical output across scans');
});

test('discoverRunning drops cache entries for pids that stop listening', async () => {
  const s = servers();
  let live = new Map([['100', new Set([3000])]]);
  s._listeningPids = async () => live;
  stampPids(s);
  let calls = 0;
  s._resolvePid = async (pid) => {
    calls++;
    return { cwd: `/c/${pid}`, top: `/top/${pid}` };
  };

  await s.discoverRunning(); // resolves 100
  await s.discoverRunning(); // cached → no new resolve
  assert.equal(calls, 1, '100 resolved once across two scans');

  live = new Map([['200', new Set([4000])]]); // 100 gone, 200 appears
  await s.discoverRunning();
  assert.equal(calls, 2, '200 resolved once');
  assert.equal(s._pidInfoCache.has('100'), false, 'stale pid pruned from the cache');
  assert.equal(s._pidInfoCache.has('200'), true, 'live pid cached');
});

/*
 * A cached pid is a cached PROCESS, and the OS reuses the number.
 *
 * The cache was keyed on the pid alone and evicted only when that pid stopped appearing
 * in the LISTEN scan. So a dev server that exited and had its pid handed to an unrelated
 * listener before the next sweep — the same second on a busy machine — went on being
 * reported as the old worktree, now "running" on the stranger's ports. The row kept a
 * live Stop button for a server that was gone, and reconcileSlots never reclaimed the
 * feature's slot because something was always listening for it.
 */
test('discoverRunning re-resolves a pid whose process was replaced between scans', async () => {
  const s = servers();
  s._listeningPids = async () => new Map([['100', new Set([3000])]]);
  let started = 1_700_000_000_000;
  s._psInfo = async () => ({ startedAt: started, command: 'whatever' });
  let resolves = 0;
  s._resolvePid = async () => {
    resolves++;
    return { cwd: '/cwd', top: resolves === 1 ? '/top/old-feature' : '/top/the-stranger' };
  };

  assert.deepEqual([...(await s.discoverRunning()).keys()], ['/top/old-feature']);
  // Same pid, a process that started later: the number was recycled.
  started += 5000;
  const after = await s.discoverRunning();
  assert.equal(resolves, 2, 'the entry was invalidated rather than served from cache');
  assert.deepEqual([...after.keys()], ['/top/the-stranger'], 'reported as whoever really holds it');
  assert.equal(after.has('/top/old-feature'), false, 'and the dead worktree is not still "running"');
});

test('a pid ps cannot stamp is re-resolved every scan rather than trusted', async () => {
  // lsof is still the authority on what is listening, so the worktree is reported — but
  // an entry with no start time can never be shown to be the same process next time, and
  // the cache degrades to no cache rather than to a stale claim.
  const s = servers();
  s._listeningPids = async () => new Map([['100', new Set([3000])]]);
  s._psInfo = async () => null;
  let resolves = 0;
  s._resolvePid = async () => {
    resolves++;
    return { cwd: '/cwd', top: '/top/feat' };
  };

  assert.deepEqual([...(await s.discoverRunning()).keys()], ['/top/feat']);
  await s.discoverRunning();
  assert.equal(resolves, 2, 'an unstampable entry is never served from cache');
});

// isSlotted — drives the "no stop & switch conflict" behavior for concurrency repos
test('isSlotted is true only for a configured repo while concurrency is enabled', async () => {
  const s = servers();
  assert.equal(s.isSlotted('accept-blue'), true, 'configured repo');
  assert.equal(s.isSlotted('some-other-repo'), false, 'repo with no concurrency config');
  assert.equal(servers({ enabled: false }).isSlotted('accept-blue'), false, 'concurrency disabled');
});

// ---------------------------------------------------------------------------
// The slot-reclaim race: a launch that outlasts one sweep
//
// start() polls up to ~8 s for ports to bind; server.ts sweeps reconcileSlots()
// every ~3 s. A feature that is slow to come up is, to a sweep, indistinguishable
// from a dead one — so its slot used to be reclaimed mid-launch and handed to
// another feature, which then bound the very ports the first one was about to.
//
// These drive the real thing: a real child process that binds its port late, a
// real sweep inside that window.
// ---------------------------------------------------------------------------

import net from 'net';

// A port nobody is using yet. Bound and released, so start()'s pre-check passes.
function freePort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', async () => {
      const { port } = srv.address() as import('net').AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

// A Servers whose 'api' repo starts a server that binds `port` only after `delayMs`.
function slowStarting(port: number, delayMs: number) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-race-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-race-repo-'));
  const wt = path.join(repo, '.worktrees', 'feat-slow');
  fs.mkdirSync(wt, { recursive: true });
  const cmd = `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    `setTimeout(() => require('http').createServer((q, s) => s.end()).listen(${port}, '127.0.0.1'), ${delayMs})`,
  )}`;
  const cfg = {
    _stateDir: stateDir,
    web: { port: 0 },
    start: { api: { cmd, ports: [port] } },
    concurrency: {
      enabled: true,
      offsetStep: 100,
      maxSlots: 3,
      repos: { api: { portEnv: { API_PORT: port } } },
    },
  };
  return { s: new Servers(cfg), wt, repo, stateDir };
}

test('a slot is not reclaimable while its feature is still starting', { timeout: 60000 }, async () => {
  const port = await freePort();
  const { s, wt, repo } = slowStarting(port, 1800);
  const feature = s.featureFor(wt);
  assert.equal(feature, 'feat-slow');
  assert.deepEqual(await s.allocSlotFor(feature), { slot: 0 });

  const launching = s.start('api', wt, { ports: [port] });
  try {
    // Land a sweep squarely inside the window where the child is up but its port
    // is not — exactly what the periodic refresh does every ~3 s.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await s.portPid(port), null, 'the child is up but has not bound its port yet');
    s.reconcileSlots(new Map()); // lsof found nothing listening anywhere

    assert.equal(s.slots.has(feature), true, 'the slot survived a sweep taken mid-launch');
    assert.equal(s.slots.get(feature), 0);
    // and the consequence that made this a port collision: the slot was handed out again
    assert.deepEqual(await s.allocSlotFor('feat-other'), { slot: 1 }, 'no other feature was given the same slot');
    assert.equal(s.isStarting(feature), true, 'the launch is still in flight');

    expectOk(await launching, 'start()');
    assert.equal(s.isStarting(feature), false, 'the guard lifts when the launch ends');

    // The guard is scoped to the launch, not a permanent exemption: once the start
    // is over, a feature with nothing listening is still reclaimed.
    s.reconcileSlots(new Map());
    assert.equal(s.slots.has(feature), false, 'a finished-but-dead feature is still self-healed away');
  } finally {
    await launching.catch(() => {});
    await s.stop('api', wt);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a restart holds the guard across the stop/settle gap, not just the start', async () => {
  // restart() stops, waits 800 ms, then starts — a window with nothing listening by
  // design. The guard has to span all of it or the slot it means to reuse is gone.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-race-restart-'));
  const s = new Servers({ _stateDir: stateDir, web: { port: 0 }, start: {}, concurrency: concurrency() });
  const wt = '/repo/.worktrees/feat-r';
  await s.allocSlotFor(s.featureFor(wt));

  const restarting = s.restart('api', wt); // no start config for 'api' → start() returns an error
  await new Promise((r) => setTimeout(r, 300)); // inside the 800 ms settle
  s.reconcileSlots(new Map());
  assert.equal(s.slots.has('feat-r'), true, 'the slot survived a sweep during the restart gap');
  assert.equal(s.isStarting('feat-r'), true, 'and the restart is still in flight');

  await restarting;
  assert.equal(s.isStarting('feat-r'), false);
  s.reconcileSlots(new Map());
  assert.equal(s.slots.has('feat-r'), false, 'and is released once the restart is over and nothing came up');
});

// ---------------------------------------------------------------------------
// tracked pids are a kill target, so they have to be self-validating
//
// `tracked` is persisted to servers.json and survives daemon restarts and
// reboots. Nothing pruned it, and stop() trusted `process.kill(pid, 0)` — which
// proves only that SOME process holds the number. After a reboot pids restart
// low, so a record written days ago naming a pid that now belongs to something
// else is ordinary. stop() then SIGTERM'd its whole process GROUP, and stop() is
// reached with no running check from DELETE /sessions/:id.
// ---------------------------------------------------------------------------

import { spawn } from 'child_process';

// A live process that is emphatically not a Studio dev server.
// `ChildProcess.pid` is `number | undefined` — undefined only when the spawn itself
// failed, which for `sleep` means the test cannot run at all. Assert it once here so
// every use below is a plain number.
function bystander(): { pid: number } {
  const p = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  p.unref();
  return { pid: present(p.pid, 'a spawned pid') };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// A process that has just been signalled stays visible to kill(pid, 0) until it is
// reaped, so "did it die?" is only answerable after a beat.
const settle = () => new Promise((r) => setTimeout(r, 400));

// Servers with a state dir of its own and no start config (so stop() does no
// port sweep and the tracked pid is the only thing under test).
function bare() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-tracked-'));
  return new Servers({ _stateDir: stateDir, web: { port: 0 }, start: {} });
}

test('stop() does not signal a pid that was recycled since the record was written', async () => {
  const victim = bystander();
  const s = bare();
  const wt = '/repo/.worktrees/feat-old';
  // Exactly the shape servers.json holds after a reboot: our record, someone
  // else's process wearing the pid it names.
  s.tracked[wt] = {
    pid: victim.pid,
    repo: 'api',
    log: '/dev/null',
    startedAt: Date.now() - 3 * 24 * 3600 * 1000,
  };

  await s.stop('api', wt);
  await settle(); // a SIGTERMed child lingers in the process table until it is reaped

  assert.equal(alive(victim.pid), true, 'an unrelated process survived a stop() aimed at its pid');
  assert.equal(s.tracked[wt], undefined, 'and the dangerous record was dropped');
  try {
    process.kill(victim.pid, 'SIGKILL');
  } catch {
    /* */
  }
});

test('stop() still signals a process this Servers really launched', async () => {
  const ours = bystander();
  const s = bare();
  const wt = '/repo/.worktrees/feat-live';
  s.tracked[wt] = { pid: ours.pid, repo: 'api', log: '/dev/null', startedAt: Date.now() };

  assert.equal(await s._trackedPidState(s.tracked[wt]), 'ours');
  const r = await s.stop('api', wt);
  assert.equal(r.killed, true, 'the real dev server is still stopped');
  await settle();
  assert.equal(alive(ours.pid), false);
});

test('a record written before startedAt existed is validated against the launch command', async () => {
  // servers.json outlives upgrades, and the user's live file has three such rows.
  const ours = bystander();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-tracked-legacy-'));
  const s = new Servers({
    _stateDir: stateDir,
    web: { port: 0 },
    start: { api: { cmd: 'definitely-not-what-sleep-runs', ports: [] } },
  });
  const wt = '/repo/.worktrees/feat-legacy';
  s.tracked[wt] = { pid: ours.pid, repo: 'api', log: '/dev/null' }; // no startedAt

  await s.stop('api', wt);
  await settle();
  assert.equal(alive(ours.pid), true, 'legacy records are not a licence to kill');
  assert.equal(s.tracked[wt], undefined, 'the unverifiable record was dropped rather than trusted');
  try {
    process.kill(ours.pid, 'SIGKILL');
  } catch {
    /* */
  }
});

test('pruneTracked drops stale and recycled records and keeps live ones', async () => {
  const ours = bystander();
  const stranger = bystander();
  const s = bare();
  s.tracked['/repo/.worktrees/live'] = { pid: ours.pid, repo: 'api', log: 'l', startedAt: Date.now() };
  s.tracked['/repo/.worktrees/recycled'] = {
    pid: stranger.pid,
    repo: 'api',
    log: 'l',
    startedAt: Date.now() - 864e5,
  };
  s.tracked['/repo/.worktrees/dead'] = { pid: 2 ** 22, repo: 'api', log: 'l', startedAt: Date.now() };

  const dropped = await s.pruneTracked();
  assert.deepEqual(Object.keys(s.tracked), ['/repo/.worktrees/live']);
  assert.deepEqual(dropped.map((d) => d.worktreePath).sort(), [
    '/repo/.worktrees/dead',
    '/repo/.worktrees/recycled',
  ]);
  // durable — the next daemon reads a pruned file
  assert.deepEqual(
    Object.keys(new Servers({ _stateDir: s.cfg._stateDir, web: { port: 0 }, start: {} }).tracked),
    ['/repo/.worktrees/live'],
  );

  for (const p of [ours.pid, stranger.pid]) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* */
    }
  }
});

test('start() records the moment it spawned, so its own pid validates', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-tracked-start-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-tracked-repo-'));
  const s = new Servers({
    _stateDir: stateDir,
    web: { port: 0 },
    start: { api: { cmd: 'exec sleep 20', ports: [] } },
  });
  expectOk(await s.start('api', repo), 'start()');
  const t = present(s.tracked[repo], 'the tracked record');
  assert.ok(t.startedAt, 'the record carries a start stamp');
  assert.equal(await s._trackedPidState(t), 'ours');
  await s.stop('api', repo);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A stop is a long act, and a start can land in the middle of it
//
// stop() awaits a `ps`, an `lsof` per port and a 600 ms settle. All of that used to
// happen outside the per-worktree lock start() takes, and it ended by deleting the
// tracked record unconditionally — so Stop-then-Start, a sequence a user performs in
// under a second, spawned a new dev server and then forgot it. These spawn real
// children, because what is under test is the interleaving of two real processes.
// ---------------------------------------------------------------------------

import { execFileSync } from 'child_process';

// A directory that is its own git top-level, which is what _resolvePid compares a
// listening process's cwd against — a plain temp dir resolves to no worktree at all,
// or worse to whatever repo contains the temp path, and the sweep then skips it.
function gitWorktree(): string {
  const dir = realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wts-live-')));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

// A Servers whose 'api' repo runs `cmd` in a real git worktree.
function live(cmd: string, ports: number[] = []) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-live-state-'));
  const wt = gitWorktree();
  const s = new Servers({ _stateDir: stateDir, web: { port: 0 }, start: { api: { cmd, ports } } });
  return { s, wt, cleanup: () => fs.rmSync(wt, { recursive: true, force: true }) };
}

// `node -e`, as a start command a shell will exec into (so the tracked pid is the
// node process itself, and its group is the thing stop() signals).
function nodeCmd(body: string): string {
  return `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(body)}`;
}

test('a start racing a stop leaves exactly one tracked, killable server', async () => {
  const { s, wt, cleanup } = live('exec sleep 30');
  const first = expectOk(await s.start('api', wt), 'first start');
  const oldPid = present(first.pid, 'the first pid');

  // Stop takes the lock synchronously, before it returns its promise; the start that
  // follows queues behind it instead of interleaving with it. Without the lock, start()
  // spawned while the stop was still awaiting `ps`, and the stop then deleted the record
  // that had just been written for the NEW process — live, untracked, unkillable.
  const stopping = s.stop('api', wt);
  const starting = s.start('api', wt);
  const [, startResult] = await Promise.all([stopping, starting]);
  const second = expectOk(startResult, 'the racing start');
  const newPid = present(second.pid, 'the second pid');

  assert.notEqual(newPid, oldPid, 'the racing start really did launch a second process');
  const t = present(s.tracked[wt], 'the tracked record after the race');
  assert.equal(t.pid, newPid, 'the record names the server that is actually up');
  assert.equal(alive(newPid), true);
  await settle();
  assert.equal(alive(oldPid), false, 'and the one that was stopped is gone');

  // Killable, which is the whole point of being tracked.
  const out = await s.stop('api', wt);
  assert.equal(out.killed, true);
  await settle();
  assert.equal(alive(newPid), false);
  assert.equal(s.tracked[wt], undefined, 'a proven stop still forgets the record');
  cleanup();
});

/*
 * A dev server that DECLINES SIGTERM must be reported, and must stay tracked.
 *
 * `process.on('SIGTERM')` and carry on is ordinary — nodemon, a graceful-shutdown handler
 * with a long drain, a wrapper that swallows signals. stop() escalates to SIGKILL and
 * reports the port in `stillListening`, but it used to delete the tracked record BEFORE
 * the settle and the escalation had even run. So if the process also outlived SIGKILL, or
 * lsof stopped resolving it, what was left was a live server holding this feature's ports
 * with nothing naming it: invisible in the UI, unreachable by Stop, and its slot handed to
 * the next feature by reconcileSlots.
 */
test('a server that ignores SIGTERM is reported in stillListening, and is not forgotten', async () => {
  const port = await freePort();
  const { s, wt, cleanup } = live(
    nodeCmd(
      `process.on('SIGTERM', () => {}); require('http').createServer((q, r) => r.end()).listen(${port}, '127.0.0.1')`,
    ),
    [port],
  );
  const started = expectOk(await s.start('api', wt), 'start()');
  assert.equal(started.listening, true, 'the stubborn server is genuinely up');
  const pid = present(started.pid, 'its pid');

  const out = await s.stop('api', wt);
  assert.deepEqual(out.stillListening, [port], 'the port it refused to give up is named');
  const t = present(s.tracked[wt], 'the tracked record');
  assert.equal(t.pid, pid, 'a stop that had to escalate does not silently drop its record');

  // And the record is not a leak either: it goes as soon as reality agrees it should.
  await settle();
  assert.equal(alive(pid), false, 'SIGKILL is not declinable');
  assert.deepEqual(
    (await s.pruneTracked()).map((d) => d.worktreePath),
    [wt],
  );
  cleanup();
});

/*
 * Two worktrees of one repo run the SAME command.
 *
 * A record written before `startedAt` existed is validated against the launch command,
 * and `bash -lc npm run dev` is byte-identical across every worktree of a repo. So a
 * recycled pid that now belongs to a SIBLING worktree's dev server passed that test and
 * was signalled as ours — `kill(-pid)` on a process group in a feature the user was
 * working in and had not touched. Where the process lives is what separates the two.
 */
test('a legacy record does not authorise killing a sibling worktree running the same command', async () => {
  // No `exec`: bash execs the last command of a -lc script anyway, so the tracked pid
  // ends up wearing exactly the configured command — which is the whole point here. That
  // is what two worktrees of one repo look like to `ps`: identical.
  const { s, wt: sibling, cleanup } = live('sleep 30');
  const mine = gitWorktree();
  const theirs = expectOk(await s.start('api', sibling), 'the sibling launch');
  const theirPid = present(theirs.pid, 'the sibling pid');

  // servers.json as an upgrade leaves it: our worktree, no start stamp, and a pid the OS
  // has since handed to the identical dev server of the worktree next door.
  s.tracked[mine] = { pid: theirPid, repo: 'api', log: '/dev/null' };
  assert.equal(await s._trackedPidState(s.tracked[mine], mine), 'stranger', 'not ours to signal');

  await s.stop('api', mine);
  await settle();
  assert.equal(alive(theirPid), true, "the sibling's dev server survived a stop of another worktree");
  assert.equal(s.tracked[mine], undefined, 'and the record that would have killed it is gone');

  // The same record, filed under the worktree the process really lives in, IS ours.
  assert.equal(await s._trackedPidState({ pid: theirPid, repo: 'api' }, sibling), 'ours');
  await s.stop('api', sibling);
  fs.rmSync(mine, { recursive: true, force: true });
  cleanup();
});

// ---------------------------------------------------------------------------
// stopAll — the counterpart of startAll: stop, refresh, then release only what
// the stop really emptied. Five routes spelled this sequence out by hand and
// disagreed about the order and the guard.
// ---------------------------------------------------------------------------

test('stopAll frees the slot of a feature it really brought down', async () => {
  const s = servers();
  s.portPid = async () => null;
  const wt = '/repo/.worktrees/feat-a';
  s.allocSlotFor(s.featureFor(wt));

  const out = await s.stopAll([{ repo: 'accept-blue', worktreePath: wt }], async () => new Map());
  assert.deepEqual(
    out.map((r) => r.repo),
    ['accept-blue'],
  );
  assert.equal(s.slots.has('feat-a'), false, 'nothing of the feature is listening, so the slot goes back');
});

test('stopAll keeps the slot of a feature that is still listening', async () => {
  const s = servers();
  s.portPid = async () => null;
  const wt = '/repo/.worktrees/feat-a';
  s.allocSlotFor(s.featureFor(wt));

  // The refresh answers with a sibling worktree of the SAME feature still up — the case
  // an unconditional release got wrong: the caller stopped what it knew about, which is
  // not the same as the feature being down.
  await s.stopAll(
    [{ repo: 'accept-blue', worktreePath: wt }],
    // A sibling WORKTREE of the same feature — another repo, the same feature name.
    async () => new Map([['/fe/.worktrees/feat-a', { pid: 7, ports: [3130] }]]),
  );
  assert.equal(s.slots.get('feat-a'), 0, 'the slot stays held while its ports are still in use');
});

test('stopAll reads the running map AFTER the stops, never before', async () => {
  const s = servers();
  s.portPid = async () => null;
  const order: string[] = [];
  s.stop = async (repo: string) => {
    order.push(`stop:${repo}`);
    return { ok: true as const, killed: true, stillListening: [] };
  };
  await s.stopAll(
    [
      { repo: 'accept-blue', worktreePath: '/repo/.worktrees/feat-a' },
      { repo: 'merchant-v3', worktreePath: '/fe/.worktrees/feat-a' },
    ],
    async () => {
      order.push('refresh');
      return new Map();
    },
  );
  assert.deepEqual(order.at(-1), 'refresh', 'the guard reads the post-stop world');
  assert.equal(order.length, 3, 'one refresh for the batch, not one per member');
});
