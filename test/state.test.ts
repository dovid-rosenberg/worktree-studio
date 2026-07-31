// The state payload contract (server/state.ts): what /api/state, every SSE frame,
// SwiftBar and Alfred read. Covers the seams the extraction introduced — the deps
// getters, the topology/session-state halves, and group resolution — against fake
// collaborators, so no repos are scanned and no lsof runs.
import { test } from 'node:test';
import assert from 'node:assert';
import { createState } from '../server/state.ts';
import type { StateDeps, StateManager, StateRepo, StateServers } from '../server/state.ts';
import type { RunningServer } from '../server/servers.ts';
import type { Config, PartialDeep, Session, Worktree } from '../server/types.ts';
import { muxStub, present, session, sessionRepo } from './helpers.ts';

// A Servers stand-in: `running` is a Map(path → {pid,ports}) keyed by real path,
// which for these fixtures is the path itself.
interface FakeServersOpts {
  startable?: string[];
  slotted?: string[];
  slots?: Map<string, number>;
}
function fakeServers({ startable = [], slotted = [], slots = new Map<string, number>() }: FakeServersOpts = {}): StateServers {
  return {
    slots,
    startCfg: (repo: string) => (startable.includes(repo) ? { cmd: 'x', ports: [] } : null),
    isSlotted: (repo: string) => slotted.includes(repo),
    decorate({ path, repo }: Pick<Worktree, 'path' | 'repo'>, running: Map<string, RunningServer>) {
      const hit = running.get(path);
      return { running: !!hit, pid: hit ? hit.pid : null, ports: hit ? hit.ports : [], canStart: startable.includes(repo) };
    },
  };
}

// The real manager hands topology() one Map(resolvedPath → session); these
// fixtures use paths that resolve to themselves.
function fakeManager(sessions: Session[] = [], byWorktree: Record<string, Session> = {}): StateManager {
  return {
    all: () => sessions,
    sessionIndex: (resolve: (p: string) => string = (p) => p) =>
      new Map(Object.entries(byWorktree).map(([p, s]): [string, Session] => [resolve(p), s])),
  };
}

// One repo with its main checkout plus two linked worktrees of the same feature name.
function repoFixture(): StateRepo[] {
  return [{
    name: 'api', path: '/code/api', defaultBranch: 'develop',
    worktrees: [
      { path: '/code/api', name: 'api', branch: 'develop', isMain: true, detached: false, merged: false },
      { path: '/code/api/.worktrees/feat-a', name: 'feat-a', branch: 'feature/a', isMain: false, detached: false, merged: false },
      { path: '/code/api/.worktrees/feat-b', name: 'feat-b', branch: 'feature/b', isMain: false, detached: false, merged: true },
    ],
  }];
}

interface BuildOver {
  cfg?: PartialDeep<Config>;
  repos?: StateRepo[];
  running?: Map<string, RunningServer>;
  manager?: StateManager;
  servers?: StateServers;
  mux?: StateDeps['mux'];
}
function build(over: BuildOver = {}) {
  const cfg: PartialDeep<Config> = {
    baseDirs: ['/code'], web: { port: 7788 }, _file: '/cfg.json',
    editors: { Zed: { open: 'z {path}' } }, defaultEditor: 'Zed',
    webRepos: ['api'], runConfigs: {}, groups: [],
    ...(over.cfg || {}),
  };
  let repos = over.repos || repoFixture();
  let running: Map<string, RunningServer> = over.running || new Map();
  const state = createState({
    cfg,
    manager: over.manager || fakeManager(),
    servers: over.servers || fakeServers(),
    mux: over.mux === undefined ? { name: 'tmux' } : over.mux,
    repos: () => repos,
    running: () => running,
  });
  return { state, cfg, setRepos: (r: StateRepo[]) => { repos = r; }, setRunning: (m: Map<string, RunningServer>) => { running = m; } };
}

test('buildState is exactly topology + sessionState, in that key order', async () => {
  const { state } = build();
  const st = await state.buildState();
  assert.deepEqual(Object.keys(st), [...Object.keys(state.topology()), ...Object.keys(state.sessionState())]);
  assert.deepEqual(Object.keys(state.sessionState()), ['sessions', 'servers'],
    'the session-state half is the separable slice a later SSE split streams as deltas');
});

test('the payload carries the fields SwiftBar and Alfred read', async () => {
  const running = new Map([['/code/api/.worktrees/feat-a', { pid: 42, ports: [1233, 3030] }]]);
  const { state } = build({ running, servers: fakeServers({ startable: ['api'] }) });
  const st = await state.buildState();
  assert.equal(st.mux, 'tmux');
  assert.equal(st.runningTotal, 1, 'SwiftBar renders the menubar count from runningTotal');
  assert.deepEqual(st.config, { port: 7788, configFile: '/cfg.json' });
  const wt = present(present(st.repos[0]).worktrees.find((w) => w.wtname === 'feat-a'), 'the feat-a row');
  // Alfred's filter reads exactly these per-worktree keys.
  assert.equal(wt.repo, 'api');
  assert.equal(wt.branch, 'feature/a');
  assert.equal(wt.path, '/code/api/.worktrees/feat-a');
  assert.equal(wt.running, true);
  assert.equal(wt.pid, 42);
  assert.deepEqual(wt.ports, [1233, 3030]);
  assert.equal(wt.canStart, true);
  assert.equal(wt.baseBranch, 'develop');
  assert.equal(wt.baseDir, '/code');
  assert.equal(wt.merged, false);
});

test('a worktree carries a trimmed view of its session; main checkouts never do', async () => {
  // `secret` is the point: an extra field on the session must not reach the embedded copy.
  const sess = { ...session({ id: 's_1', state: 'waiting', activity: 'waiting for you', muxName: 'wts-a' }), secret: 'not exposed' };
  const { state } = build({
    manager: fakeManager([sess], { '/code/api/.worktrees/feat-a': sess, '/code/api': sess }),
  });
  const st = await state.buildState();
  const wts = st.repos[0].worktrees;
  assert.deepEqual(present(wts.find((w) => w.wtname === 'feat-a'), 'the feat-a row').session,
    { id: 's_1', state: 'waiting', activity: 'waiting for you', muxName: 'wts-a' });
  assert.equal(present(wts.find((w) => w.isMain), 'the main checkout').session, null, 'the main checkout is never session-decorated');
});

test('a feature surfaces its driving session and its concurrency slot', async () => {
  const sess = session({ id: 's_1', state: 'working', activity: 'thinking…', muxName: 'wts-a' });
  const { state } = build({
    manager: fakeManager([sess], { '/code/api/.worktrees/feat-a': sess }),
    servers: fakeServers({ slots: new Map([['feat-a', 2]]) }),
  });
  const st = await state.buildState();
  const a = present(st.features.find((f) => f.name === 'feat-a'), 'feature feat-a');
  const b = present(st.features.find((f) => f.name === 'feat-b'), 'feature feat-b');
  assert.equal(present(a.session, "feat-a's session").id, 's_1');
  assert.equal(a.slot, 2, 'the allocated slot powers the Fleet badge');
  assert.equal(b.session, null);
  assert.equal('slot' in b, false, 'no slot key when the feature has none allocated');
});

test('sessionState reports every repo a session owns, with its live server state', async () => {
  const sessions = [session({
    id: 's_1', repoName: 'api', worktreePath: '/code/api/.worktrees/feat-a',
    repos: [
      sessionRepo({ repo: 'api', worktreePath: '/code/api/.worktrees/feat-a' }),
      sessionRepo({ repo: 'fe', worktreePath: '/code/fe/.worktrees/feat-a' }),
      sessionRepo({ repo: 'unpromoted', worktreePath: null }),
    ],
  })];
  const { state } = build({
    manager: fakeManager(sessions),
    servers: fakeServers({ startable: ['api'] }),
    running: new Map([['/code/api/.worktrees/feat-a', { pid: 7, ports: [1233] }]]),
  });
  const st = await state.buildState();
  assert.deepEqual(present(st.servers.s_1, "s_1's server state").repos, [
    { repo: 'api', worktreePath: '/code/api/.worktrees/feat-a', running: true, ports: [1233], canStart: true },
    { repo: 'fe', worktreePath: '/code/fe/.worktrees/feat-a', running: false, ports: [], canStart: false },
  ], 'repos without a worktree are not part of the shared workspace view');
});

test('a session with no owned repos at all is left out of the servers map', async () => {
  const { state } = build({ manager: fakeManager([session({ id: 's_1', repos: [], worktreePath: null })]) });
  const st = await state.buildState();
  assert.deepEqual(st.servers, {});
});

test('repos and running are read through getters, so a refresh is picked up', async () => {
  const { state, setRepos, setRunning } = build();
  assert.equal((await state.buildState()).runningTotal, 0);
  setRunning(new Map([['/code/api/.worktrees/feat-a', { pid: 1, ports: [3000] }]]));
  assert.equal((await state.buildState()).runningTotal, 1, 'the replaced lsof map is seen, not a captured stale one');
  setRepos([]);
  assert.deepEqual((await state.buildState()).repos, [], 'the replaced scan cache is seen too');
});

test('resolveGroup finds a feature, drops missing members and returns every worktree flat', async () => {
  const { state } = build({
    cfg: { groups: [{ name: 'Manual', members: ['api/feat-a', 'ghost/nope'] }] },
  });
  const { group, flat } = await state.resolveGroup('Manual');
  const g = present(group, "the 'Manual' group");
  assert.equal(g.members.length, 1, 'the unresolvable member is dropped');
  assert.equal(present(g.members[0]).wtname, 'feat-a');
  assert.equal(flat.length, 3, 'flat is every worktree of every repo, main checkout included');
});

test('resolveGroup returns a null group for an unknown name', async () => {
  const { state } = build();
  assert.deepEqual(await state.resolveGroup('nope'), { group: null, flat: [] });
});

test('conflictsFor lists only same-repo worktrees running elsewhere', async () => {
  const { state } = build();
  const flat = [
    { repo: 'api', path: '/a', running: true },
    { repo: 'api', path: '/b', running: false },
    { repo: 'api', path: '/c', running: true },
    { repo: 'fe', path: '/d', running: true },
  ];
  const out = state.conflictsFor({ repo: 'api', path: '/a' }, flat);
  assert.deepEqual(out.map((w) => w.path), ['/c'], 'not itself, not a stopped sibling, not another repo');
});

test('conflictsFor is empty for a slotted repo — it runs on its own offset ports', async () => {
  const { state } = build({ servers: fakeServers({ slotted: ['api'] }) });
  const flat = [{ repo: 'api', path: '/a', running: true }, { repo: 'api', path: '/c', running: true }];
  assert.deepEqual(state.conflictsFor({ repo: 'api', path: '/a' }, flat), []);
});

test('mux reports "none" when no multiplexer was found', async () => {
  const { state } = build({ mux: null });
  assert.equal((await state.buildState()).mux, 'none');
});

/* ---------------- path resolution ---------------- */
// topology() used to ask manager.sessionForWorktree() per worktree, and each of
// those re-scanned every session while calling synchronous realpathSync on every
// path it owned. These cover what replaced it — one index and one realpath per
// path per generation — against the REAL SessionManager and real dirs on disk,
// because the whole point is what the syscalls do.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager } from '../server/sessions.ts';
import { Servers } from '../server/servers.ts';

// Count realpathSync calls made while fn runs (util.ts resolves through this same
// module object, so swapping the property is enough).
function countRealpaths(fn: () => void): number {
  const real = fs.realpathSync;
  let n = 0;
  // Only the callable half is replaced; `.native` is carried over so the property
  // still satisfies everything else that may reach for it while fn runs. The cast is
  // the seam: `realpathSync` is an overloaded function object, and a counting wrapper
  // cannot reproduce every overload — the tests only ever take the string one.
  fs.realpathSync = Object.assign(
    (p: fs.PathLike) => { n++; return real(p); },
    { native: real.native },
  ) as typeof fs.realpathSync;
  try { fn(); } finally { fs.realpathSync = real; }
  return n;
}

function realManager(sessions: Session[] = []) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-state-'));
  const m = new SessionManager({ _stateDir: stateDir, web: { port: 0 }, claude: {} }, muxStub());
  for (const s of sessions) m.sessions.set(s.id, s);
  return m;
}

// A repo whose linked worktrees are symlinks to real dirs, so resolution has to
// do actual work and a cached answer is observably different from a fresh one.
function onDisk(n: number): { root: string; targets: string[]; links: string[]; repos: StateRepo[] } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wts-paths-')));
  const targets: string[] = []; const links: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = path.join(root, `target-${i}`); fs.mkdirSync(t); targets.push(t);
    const l = path.join(root, `wt-${i}`); fs.symlinkSync(t, l); links.push(l);
  }
  const worktrees = [{ path: root, name: 'api', branch: 'main', isMain: true, detached: false, merged: false },
    ...links.map((l, i) => ({ path: l, name: `feat-${i}`, branch: `b-${i}`, isMain: false, detached: false, merged: false }))];
  return { root, targets, links, repos: [{ name: 'api', path: root, defaultBranch: 'main', worktrees }] };
}

const sessionIdAt = (st: { repos: Array<{ worktrees: Worktree[] }> }, wtname: string) => {
  const w = present(st.repos[0], 'the first repo').worktrees.find((x) => x.wtname === wtname);
  return w && w.session ? w.session.id : null;
};

test('every worktree path is resolved once, then served from cache on later builds', () => {
  const disk = onDisk(4);
  const sessions = disk.targets.map((t, i) => session({ id: `s_${i}`, worktreePath: t, repos: [sessionRepo({ repo: 'api', worktreePath: t })] }));
  const { state } = build({ repos: disk.repos, manager: realManager(sessions) });

  const cold = countRealpaths(() => state.topology());
  const warm = countRealpaths(() => { state.topology(); state.topology(); state.topology(); });
  // 4 session paths + 4 linked worktrees. The main checkout is never
  // session-decorated, so it is never resolved at all.
  assert.equal(cold, 8, 'a cold build resolves each path exactly once');
  assert.equal(warm, 0, 'three further builds make no syscalls at all');

  // …and the cached answers are the right ones: each symlinked worktree finds the
  // session stored under the path it resolves to.
  const st = state.topology();
  for (let i = 0; i < 4; i++) assert.equal(sessionIdAt(st, `feat-${i}`), `s_${i}`);
  fs.rmSync(disk.root, { recursive: true, force: true });
});

test('sessionState shares the cache — a hook-driven build makes no syscalls', () => {
  const disk = onDisk(2);
  const sessions = disk.targets.map((t, i) => session({ id: `s_${i}`, worktreePath: t, repos: [sessionRepo({ repo: 'api', worktreePath: t })] }));
  const { state } = build({ repos: disk.repos, manager: realManager(sessions) });
  state.topology();
  assert.equal(countRealpaths(() => { for (let i = 0; i < 20; i++) state.sessionState(); }), 0,
    'session-state is what every Claude hook broadcasts — it must not hit the filesystem');
  fs.rmSync(disk.root, { recursive: true, force: true });
});

test('prunePaths invalidates a worktree that was removed and recreated pointing elsewhere', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wts-prune-')));
  const before = path.join(root, 'before'); fs.mkdirSync(before);
  const after = path.join(root, 'after'); fs.mkdirSync(after);
  const link = path.join(root, 'feat'); fs.symlinkSync(before, link);

  const mainRow = { path: root, name: 'api', branch: 'main', isMain: true, detached: false, merged: false };
  const featRow = { path: link, name: 'feat', branch: 'b', isMain: false, detached: false, merged: false };
  const withFeat = [{ name: 'api', path: root, defaultBranch: 'main', worktrees: [mainRow, featRow] }];
  const withoutFeat = [{ name: 'api', path: root, defaultBranch: 'main', worktrees: [mainRow] }];

  const manager = realManager([session({ id: 's_1', worktreePath: before, repos: [sessionRepo({ repo: 'api', worktreePath: before })] })]);
  let repos = withFeat;
  const deps = { cfg: { baseDirs: [root], web: { port: 0 }, groups: [] }, manager, servers: fakeServers(), mux: { name: 'tmux' }, repos: () => repos, running: () => new Map() };
  const pruned = createState(deps);
  const never = createState(deps); // same inputs, but nothing ever tells it to invalidate

  assert.equal(sessionIdAt(pruned.topology(), 'feat'), 's_1');
  assert.equal(sessionIdAt(never.topology(), 'feat'), 's_1');

  // the worktree is removed: its dir goes, the scan stops listing it, its session closes
  fs.unlinkSync(link);
  manager.sessions.clear();
  repos = withoutFeat;
  pruned.topology(); never.topology();
  pruned.prunePaths(); // ← the only difference between the two

  // …and a NEW worktree of the same name is created, resolving somewhere else
  fs.symlinkSync(after, link);
  manager.sessions.set('s_2', session({ id: 's_2', worktreePath: after, repos: [sessionRepo({ repo: 'api', worktreePath: after })] }));
  repos = withFeat;

  assert.equal(sessionIdAt(pruned.topology(), 'feat'), 's_2', 'resolved fresh, not through the dead entry');
  assert.equal(sessionIdAt(never.topology(), 'feat'), null,
    'control: without invalidation the path still resolves to where it used to point');
  fs.rmSync(root, { recursive: true, force: true });
});

test('prunePaths keeps the entries the scan and the sessions still name', () => {
  const disk = onDisk(2);
  const sessions = disk.targets.map((t, i) => session({ id: `s_${i}`, worktreePath: t, repos: [sessionRepo({ repo: 'api', worktreePath: t })] }));
  const { state } = build({ repos: disk.repos, manager: realManager(sessions) });
  state.topology();
  state.prunePaths();
  assert.equal(countRealpaths(() => state.topology()), 0, 'a prune that removes nothing must not cost a rebuild');
  fs.rmSync(disk.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A corrupt state file is preserved, not silently emptied
// ---------------------------------------------------------------------------

test('a corrupt sessions.json is kept aside instead of being replaced by an empty one', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-corrupt-sessions-'));
  const file = path.join(stateDir, 'sessions.json');
  const original = '[{"id":"s_1","claudeSessionId":"claude-abc"'; // truncated mid-write
  fs.writeFileSync(file, original);

  const m = new SessionManager({ _stateDir: stateDir, web: { port: 0 }, claude: {} }, muxStub());
  assert.equal(m.all().length, 0, 'boots empty rather than throwing');

  assert.ok(!fs.existsSync(file), 'the unreadable file was moved out of the way, not left to be overwritten');
  const kept = fs.readdirSync(stateDir).find((f) => f.startsWith('sessions.json.corrupt-'));
  assert.ok(kept, `no preserved copy in ${fs.readdirSync(stateDir).join(', ')}`);
  assert.equal(fs.readFileSync(path.join(stateDir, kept), 'utf8'), original,
    'the claudeSessionId values are still recoverable by hand');
});

test('a corrupt servers.json is kept aside too', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-corrupt-servers-'));
  const file = path.join(stateDir, 'servers.json');
  fs.writeFileSync(file, '{"tracked":{');
  const s = new Servers({ _stateDir: stateDir, web: { port: 0 }, start: {} });
  assert.deepEqual(s.tracked, {});
  assert.ok(fs.readdirSync(stateDir).some((f) => f.startsWith('servers.json.corrupt-')));
});

// ---- decorate()'s answer must survive the trip ------------------------------
//
// topology() used to copy four named fields off decorate()'s result — running, pid,
// ports, canStart — so `depsMissing`, added to decorate() later, was computed and then
// silently dropped here. The rail's "deps missing" pill could never render, and nothing
// failed anywhere: an absent boolean reads as false at every consumer.
//
// This asserts the general rule rather than that one field, so the next thing decorate()
// learns cannot be lost the same way.

test('every field decorate() returns reaches the worktree row', () => {
  const marker = 'x-decorate-marker';
  const servers = {
    slots: new Map(),
    startCfg: () => ({ cmd: 'x', ports: [] }),
    isSlotted: () => false,
    decorate: () => ({
      running: false, pid: null, ports: [], canStart: true,
      depsMissing: true,
      depsInstalling: true,
      // A field state.ts has never heard of: if topology() is picking names, this is
      // what goes missing, and this test is what notices.
      [marker]: 'kept',
    }),
  } as unknown as StateServers;

  const { state } = build({ servers });
  const wt = state.topology().repos[0].worktrees.find((w) => !w.isMain);
  const row = present(wt, 'a linked worktree') as unknown as Record<string, unknown>;

  assert.equal(row.depsMissing, true, 'depsMissing must reach the client');
  assert.equal(row.depsInstalling, true, 'depsInstalling must reach the client');
  assert.equal(row[marker], 'kept', 'topology() must not hand-pick decorate()’s fields');
});
