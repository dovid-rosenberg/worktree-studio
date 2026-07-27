'use strict';
// The route-module convention and the API versioning that rides on it: feature
// modules call register(app, deps) against ONE router, and server.js mounts that
// router at both /api/v1 (versioned) and /api (the unversioned aliases SwiftBar,
// Alfred and the current web UI call). Every route must answer identically under
// both prefixes — that equivalence is what those clients depend on.
//
// Exercised through a real express app on an ephemeral port, with fake deps, so
// nothing is spawned and no git/lsof runs.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const orchestrator = require('../server/orchestrator');
const { createForge } = require('../server/forge');

const WT = (name) => `/code/api/.worktrees/${name}`;

// Records what the orchestrator asked of the collaborators it was handed.
function harness({ group, flat = [], conflicts = [], allocError = null } = {}) {
  const calls = { stopped: [], started: [], released: [], allocated: [], broadcasts: 0 };
  const servers = {
    allocSlotFor: (f) => { calls.allocated.push(f); return allocError ? { error: allocError } : { slot: 0 }; },
    releaseSlot: (f) => calls.released.push(f),
    launchOpts: () => ({ env: {}, ports: [] }),
    stop: async (repo, p) => { calls.stopped.push([repo, p]); return { ok: true }; },
    start: async (repo, p) => { calls.started.push([repo, p]); return { ok: true }; },
    restart: async (repo, p) => { calls.started.push([repo, p]); return { ok: true }; },
  };
  const deps = {
    cfg: { editors: {}, defaultEditor: '' },
    servers,
    manager: { get: () => null, deactivate: async () => ({ ok: true }), close: async () => ({ ok: true }), sessionForWorktree: () => null },
    repos: () => [{ name: 'api', path: '/code/api' }],
    resolveGroup: async (name) => (group && name === group.name ? { group, flat } : { group: null, flat: [] }),
    conflictsFor: () => conflicts,
    refreshRunning: async () => {},
    scheduleBroadcast: () => { calls.broadcasts++; },
    rescan: async () => {},
  };

  const app = express();
  app.use(express.json());
  const api = express.Router();
  app.use('/api', api);
  app.use('/api/v1', api);
  orchestrator.register(api, deps);
  createForge({ manager: deps.manager, resolveGroup: deps.resolveGroup, providers: [] }).register(api);
  return { app, calls };
}

// Serve `app` for the duration of fn, handing it a (path, init) => Response fetcher.
async function serving(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn((p, init) => fetch(base + p, init)); }
  finally { server.close(); }
}

const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Call the same route under both prefixes and assert the answers match.
async function bothPrefixes(get, route, init) {
  const un = await get(`/api${route}`, init);
  const v1 = await get(`/api/v1${route}`, init);
  const [a, b] = [await un.json(), await v1.json()];
  assert.equal(un.status, v1.status, `${route}: same status under both prefixes`);
  assert.deepEqual(a, b, `${route}: same body under both prefixes`);
  return { status: un.status, body: a };
}

const FEATURE = {
  name: 'feat-a',
  members: [
    { repo: 'api', path: WT('feat-a'), branch: 'feature/a', wtname: 'feat-a', running: true, canStart: true },
    { repo: 'fe', path: '/code/fe/.worktrees/feat-a', branch: 'feature/a', wtname: 'feat-a', running: false, canStart: true },
  ],
};

test('every group route answers identically under /api and /api/v1', async () => {
  for (const route of ['/group/start', '/group/stop', '/group/restart', '/group/close', '/group/delete', '/group/session', '/group/pr']) {
    const { app } = harness({ group: FEATURE });
    await serving(app, async (get) => {
      const { status } = await bothPrefixes(get, route, post({ group: 'feat-a' }));
      assert.notEqual(status, 404, `${route} is registered (not an express 404)`);
    });
  }
});

test('an unknown feature is a 404 with the same body under both prefixes', async () => {
  const { app } = harness({ group: FEATURE });
  await serving(app, async (get) => {
    const { status, body } = await bothPrefixes(get, '/group/start', post({ group: 'nope' }));
    assert.equal(status, 404);
    assert.deepEqual(body, { error: 'no such feature' });
  });
});

test('/sessions/:id/ci is registered under both prefixes', async () => {
  const { app } = harness({ group: FEATURE });
  await serving(app, async (get) => {
    const { status, body } = await bothPrefixes(get, '/sessions/nope/ci');
    assert.equal(status, 404);
    assert.deepEqual(body, { error: 'no such session' }, 'the module\'s own 404, not express\'s');
  });
});

test('group/stop stops only running members and frees every member\'s slot', async () => {
  const { app, calls } = harness({ group: FEATURE });
  await serving(app, async (get) => {
    const r = await get('/api/v1/group/stop', post({ group: 'feat-a' }));
    assert.deepEqual(await r.json(), { ok: true });
  });
  assert.deepEqual(calls.stopped, [['api', WT('feat-a')]], 'the stopped member is not re-stopped');
  assert.deepEqual(calls.released, ['feat-a', 'feat-a'], 'the whole stack is down → the feature\'s slot is freed');
});

test('group/start starts the members that can start and are not already running', async () => {
  const { app, calls } = harness({ group: FEATURE });
  await serving(app, async (get) => {
    const r = await get('/api/v1/group/start', post({ group: 'feat-a' }));
    assert.deepEqual(await r.json(), { ok: true, started: 1, total: 1, failures: [] });
  });
  assert.deepEqual(calls.started, [['fe', '/code/fe/.worktrees/feat-a']]);
  assert.deepEqual(calls.allocated, ['feat-a'], 'the slot is keyed on the member\'s .worktrees/<name> basename');
});

test('group/start asks for confirmation before stopping a conflicting worktree', async () => {
  const conflict = { repo: 'fe', path: '/code/fe/.worktrees/other', running: true };
  const { app, calls } = harness({ group: FEATURE, conflicts: [conflict] });
  await serving(app, async (get) => {
    const r = await get('/api/v1/group/start', post({ group: 'feat-a' }));
    const body = await r.json();
    assert.equal(body.needsConfirm, true);
    assert.deepEqual(body.conflicts, [conflict]);
    assert.equal(body.willStart.length, 1);
  });
  assert.deepEqual(calls.started, [], 'nothing is launched until the client confirms');
  assert.deepEqual(calls.stopped, [], 'and nothing is stopped either');
});

test('group/start is a 409 when no concurrency slot is free', async () => {
  const { app, calls } = harness({ group: FEATURE, allocError: 'no free concurrency slot (max 3 running)' });
  await serving(app, async (get) => {
    const r = await get('/api/v1/group/start', post({ group: 'feat-a' }));
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { ok: false, error: 'no free concurrency slot (max 3 running)' });
  });
  assert.deepEqual(calls.started, [], 'no member is launched once the allocation failed');
});
