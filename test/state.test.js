'use strict';
// The state payload contract (server/state.js): what /api/state, every SSE frame,
// SwiftBar and Alfred read. Covers the seams the extraction introduced — the deps
// getters, the topology/session-state halves, and group resolution — against fake
// collaborators, so no repos are scanned and no lsof runs.
const { test } = require('node:test');
const assert = require('node:assert');
const { createState } = require('../server/state');

// A Servers stand-in: `running` is a Map(path → {pid,ports}) keyed by real path,
// which for these fixtures is the path itself.
function fakeServers({ startable = [], slotted = [], slots = new Map() } = {}) {
  return {
    slots,
    startCfg: (repo) => (startable.includes(repo) ? { cmd: 'x', ports: [] } : null),
    isSlotted: (repo) => slotted.includes(repo),
    decorate({ path, repo }, running) {
      const hit = running.get(path);
      return { running: !!hit, pid: hit ? hit.pid : null, ports: hit ? hit.ports : [], canStart: startable.includes(repo) };
    },
  };
}

function fakeManager(sessions = [], byWorktree = {}) {
  return {
    all: () => sessions,
    sessionForWorktree: (p) => byWorktree[p] || null,
  };
}

// One repo with its main checkout plus two linked worktrees of the same feature name.
function repoFixture() {
  return [{
    name: 'api', path: '/code/api', defaultBranch: 'develop',
    worktrees: [
      { path: '/code/api', name: 'api', branch: 'develop', isMain: true, detached: false, merged: false },
      { path: '/code/api/.worktrees/feat-a', name: 'feat-a', branch: 'feature/a', isMain: false, detached: false, merged: false },
      { path: '/code/api/.worktrees/feat-b', name: 'feat-b', branch: 'feature/b', isMain: false, detached: false, merged: true },
    ],
  }];
}

function build(over = {}) {
  const cfg = {
    baseDirs: ['/code'], web: { port: 7788 }, _file: '/cfg.json',
    editors: { Zed: { open: 'z {path}' } }, defaultEditor: 'Zed',
    webRepos: ['api'], runConfigs: {}, groups: [],
    ...(over.cfg || {}),
  };
  let repos = over.repos || repoFixture();
  let running = over.running || new Map();
  const state = createState({
    cfg,
    manager: over.manager || fakeManager(),
    servers: over.servers || fakeServers(),
    mux: over.mux === undefined ? { name: 'tmux' } : over.mux,
    repos: () => repos,
    running: () => running,
  });
  return { state, cfg, setRepos: (r) => { repos = r; }, setRunning: (m) => { running = m; } };
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
  const wt = st.repos[0].worktrees.find((w) => w.wtname === 'feat-a');
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
  const sess = { id: 's_1', state: 'waiting', activity: 'waiting for you', muxName: 'wts-a', secret: 'not exposed' };
  const { state } = build({
    manager: fakeManager([sess], { '/code/api/.worktrees/feat-a': sess, '/code/api': sess }),
  });
  const st = await state.buildState();
  const wts = st.repos[0].worktrees;
  assert.deepEqual(wts.find((w) => w.wtname === 'feat-a').session,
    { id: 's_1', state: 'waiting', activity: 'waiting for you', muxName: 'wts-a' });
  assert.equal(wts.find((w) => w.isMain).session, null, 'the main checkout is never session-decorated');
});

test('a feature surfaces its driving session and its concurrency slot', async () => {
  const sess = { id: 's_1', state: 'working', activity: 'thinking…', muxName: 'wts-a' };
  const { state } = build({
    manager: fakeManager([sess], { '/code/api/.worktrees/feat-a': sess }),
    servers: fakeServers({ slots: new Map([['feat-a', 2]]) }),
  });
  const st = await state.buildState();
  const a = st.features.find((f) => f.name === 'feat-a');
  const b = st.features.find((f) => f.name === 'feat-b');
  assert.equal(a.session.id, 's_1');
  assert.equal(a.slot, 2, 'the allocated slot powers the Fleet badge');
  assert.equal(b.session, null);
  assert.equal('slot' in b, false, 'no slot key when the feature has none allocated');
});

test('sessionState reports every repo a session owns, with its live server state', async () => {
  const sessions = [{
    id: 's_1', repoName: 'api', worktreePath: '/code/api/.worktrees/feat-a',
    repos: [
      { repo: 'api', worktreePath: '/code/api/.worktrees/feat-a' },
      { repo: 'fe', worktreePath: '/code/fe/.worktrees/feat-a' },
      { repo: 'unpromoted', worktreePath: null },
    ],
  }];
  const { state } = build({
    manager: fakeManager(sessions),
    servers: fakeServers({ startable: ['api'] }),
    running: new Map([['/code/api/.worktrees/feat-a', { pid: 7, ports: [1233] }]]),
  });
  const st = await state.buildState();
  assert.deepEqual(st.servers.s_1.repos, [
    { repo: 'api', worktreePath: '/code/api/.worktrees/feat-a', running: true, ports: [1233], canStart: true },
    { repo: 'fe', worktreePath: '/code/fe/.worktrees/feat-a', running: false, ports: [], canStart: false },
  ], 'repos without a worktree are not part of the shared workspace view');
});

test('a session with no owned repos at all is left out of the servers map', async () => {
  const { state } = build({ manager: fakeManager([{ id: 's_1', repos: [], worktreePath: null }]) });
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
  assert.equal(group.members.length, 1, 'the unresolvable member is dropped');
  assert.equal(group.members[0].wtname, 'feat-a');
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
