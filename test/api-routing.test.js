// The route-module convention and the API versioning that rides on it: feature
// modules call register(app, deps) against ONE router, and server.js mounts that
// router at both /api/v1 (versioned) and /api (the unversioned aliases SwiftBar,
// Alfred and the current web UI call). Every route must answer identically under
// both prefixes — that equivalence is what those clients depend on.
//
// Exercised through a real express app on an ephemeral port, with fake deps, so
// nothing is spawned and no git/lsof runs.
import { test } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as orchestrator from '../server/orchestrator.js';
import { createForge } from '../server/forge.ts';
import { createIdentity } from '../server/identity.js';
import * as crash from '../server/crash.ts';
import * as pricing from '../server/pricing.ts';
import { EventEmitter } from 'node:events';
import * as routesReview from '../server/routes-review.js';
import * as transcriptRoutes from '../server/transcript-routes.js';

// server.js mounts this last, after every route. The route modules used to carry their
// own async wrapper, so a harness that omitted it still got JSON out of a throwing
// handler; now the error policy belongs to the app, and a miniature that leaves it out
// is testing a wiring the daemon does not have. Silent, because the deliberately
// minimal fakes below make some routes throw on purpose.
const mountErrors = (app) => app.use(crash.routeErrors({ log: () => {} }));

// The real (default) feature-identity resolver — slot keys come from it in
// production, so the fake derives them the same way rather than hardcoding one.
const identity = createIdentity({});

const WT = (name) => `/code/api/.worktrees/${name}`;

// Records what the orchestrator asked of the collaborators it was handed.
/**
 * @param {{ group?: any, flat?: any[], conflicts?: any[],
 *           allocError?: any, startError?: any }} [opts]
 */
function harness({ group, flat = [], conflicts = [], allocError = null, startError = null } = {}) {
  const calls = { stopped: [], started: [], released: [], allocated: [], broadcasts: 0 };
  const servers = {
    identity,
    featureFor: (p) => identity.ofPath(p),
    allocSlotFor: (f) => { calls.allocated.push(f); return allocError ? { error: allocError } : { slot: 0 }; },
    releaseSlot: (f) => calls.released.push(f),
    launchOpts: () => ({ env: {}, ports: [] }),
    stop: async (repo, p) => { calls.stopped.push([repo, p]); return { ok: true }; },
    start: async (repo, p) => { calls.started.push([repo, p]); return startError ? { ok: false, error: startError } : { ok: true }; },
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
  mountErrors(app);
  return { app, calls };
}

// Serve `app` for the duration of fn, handing it a (path, init) => Response fetcher.
async function serving(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${/** @type {import('net').AddressInfo} */ (server.address()).port}`;
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

// ---------------------------------------------------------------------------
// /group/start's `ok` is a verdict, not a constant
// ---------------------------------------------------------------------------

// Both members are startable, so a failing servers.start() fails the whole stack.
const STARTABLE = {
  name: 'feat-b',
  members: [
    { repo: 'api', path: WT('feat-b'), branch: 'feature/b', wtname: 'feat-b', running: false, canStart: true },
    { repo: 'fe', path: '/code/fe/.worktrees/feat-b', branch: 'feature/b', wtname: 'feat-b', running: false, canStart: true },
  ],
};

test('group/start reports ok:false when every member failed to start', async () => {
  const { app } = harness({ group: STARTABLE, startError: 'port 3030 already in use (pid 991)' });
  await serving(app, async (get) => {
    const body = await (await get('/api/v1/group/start', post({ group: 'feat-b' }))).json();
    assert.equal(body.started, 0);
    assert.equal(body.total, 2);
    assert.equal(body.failures.length, 2);
    assert.equal(body.ok, false, 'a client keying on ok must not read total failure as success');
  });
});

test('group/start reports ok:false for a partial start too', async () => {
  // FEATURE has one member already running, so exactly one is attempted — and it fails.
  const { app } = harness({ group: FEATURE, startError: 'no start config for repo \'fe\'' });
  await serving(app, async (get) => {
    const body = await (await get('/api/v1/group/start', post({ group: 'feat-a' }))).json();
    assert.deepEqual(body, { ok: false, started: 0, total: 1, failures: [{ repo: 'fe', error: "no start config for repo 'fe'" }] });
  });
});

test('group/start with nothing to start is a no-op, not a failure', async () => {
  const allRunning = { name: 'feat-c', members: [{ repo: 'api', path: WT('feat-c'), running: true, canStart: true }] };
  const { app } = harness({ group: allRunning });
  await serving(app, async (get) => {
    const body = await (await get('/api/v1/group/start', post({ group: 'feat-c' }))).json();
    assert.deepEqual(body, { ok: true, started: 0, total: 0, failures: [] });
  });
});

test('the needsConfirm answer stays ok:true — the server is asking, not failing', async () => {
  const conflict = { repo: 'fe', path: '/code/fe/.worktrees/other', running: true };
  const { app } = harness({ group: FEATURE, conflicts: [conflict] });
  await serving(app, async (get) => {
    const body = await (await get('/api/v1/group/start', post({ group: 'feat-a' }))).json();
    assert.equal(body.needsConfirm, true);
    assert.equal(body.ok, true, 'clients branch on needsConfirm before ok');
  });
});

// ---------------------------------------------------------------------------
// The other two route modules ride the same router
// ---------------------------------------------------------------------------
//
// routes-review and transcript-routes used to mount themselves — one by looping a
// PREFIXES array against the raw app, one by app.use()-ing its own sub-router at each
// prefix. Both now register onto the router server.js mounts twice, which is the only
// one of the three idioms that is automatically correct. These tests are the proof
// that the equivalence survived the change, end to end through express.

// A manager with no sessions: every route below answers its own 404, which is exactly
// what makes it observable that the route EXISTS under both prefixes.
function routeModules() {
  const app = express();
  app.use(express.json());
  const api = express.Router();
  app.use('/api', api);
  app.use('/api/v1', api);
  const manager = { get: () => null, all: () => [], on: () => {} };
  routesReview.register(api, { manager, repos: () => [] });
  // A throwaway state dir, so the real ~/.local/state index is never opened.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-routing-'));
  const { index } = transcriptRoutes.register(api, { manager, cfg: { _stateDir: stateDir } });
  mountErrors(app);
  return { app, index, cleanup: () => { index.close(); fs.rmSync(stateDir, { recursive: true, force: true }); } };
}

test('the review routes answer identically under /api and /api/v1', async () => {
  const { app, cleanup } = routeModules();
  try {
    await serving(app, async (get) => {
      for (const route of ['/sessions/nope/diff', '/sessions/nope/hunks']) {
        const { status, body } = await bothPrefixes(get, route);
        assert.equal(status, 404, `${route} is the module's 404, not express's`);
        assert.deepEqual(body, { error: 'no such session' });
      }
      for (const route of ['/sessions/nope/hunks/stage', '/sessions/nope/hunks/unstage']) {
        const { status } = await bothPrefixes(get, route, post({ file: 'f.txt' }));
        assert.equal(status, 404);
      }
    });
  } finally { cleanup(); }
});

test('the transcript routes answer identically under /api and /api/v1', async () => {
  const { app, cleanup } = routeModules();
  try {
    await serving(app, async (get) => {
      for (const route of ['/sessions/nope/transcript', '/sessions/nope/transcript/search', '/sessions/nope/transcript/usage']) {
        const { status, body } = await bothPrefixes(get, route);
        assert.equal(status, 404);
        assert.deepEqual(body, { error: 'no such session' });
      }
      for (const route of ['/transcripts/status', '/transcripts/usage', '/transcripts/search']) {
        const { status } = await bothPrefixes(get, route);
        assert.equal(status, 200, `${route} is registered under both prefixes`);
      }
      const { status } = await bothPrefixes(get, '/transcripts/reindex', post({}));
      assert.equal(status, 200);
    });
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// The cache-billing multipliers are PUBLISHED, not re-typed by the client
// ---------------------------------------------------------------------------
//
// server/pricing.js exported CACHE_WRITE_5M / CACHE_WRITE_1H / CACHE_READ, nothing
// imported them, and no endpoint published them — so the insights UI hardcoded a copy.
// Change one and the API's dollars move while the client's "billed weight" chart keeps
// the old ratios, and the same screen answers "where did the money go" two ways.
//
// These tests fail if the numbers stop coming from pricing.js, which is the only way
// the duplication can come back.

test('/transcripts/status publishes the cache multipliers straight from pricing.js', async () => {
  const { app, cleanup } = routeModules();
  try {
    await serving(app, async (get) => {
      const { status, body } = await bothPrefixes(get, '/transcripts/status');
      assert.equal(status, 200);
      assert.deepEqual(body.pricing.cacheMultipliers, {
        input: 1, // stated, not implied, so a client can consume the map wholesale
        cacheWrite5m: pricing.CACHE_WRITE_5M,
        cacheWrite1h: pricing.CACHE_WRITE_1H,
        cacheRead: pricing.CACHE_READ,
      });
      assert.equal(body.pricing.verifiedAt, pricing.PRICING_VERIFIED);
    });
  } finally { cleanup(); }
});

test('every cost-bearing response carries the same pricing block', async () => {
  const { app, cleanup } = routeModules();
  try {
    await serving(app, async (get) => {
      const status = (await bothPrefixes(get, '/transcripts/status')).body.pricing;
      const fleet = (await bothPrefixes(get, '/transcripts/usage')).body.pricing;
      assert.deepEqual(fleet, status, 'the fleet rollup must not quote different multipliers');
    });
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Repeated query params are a malformed request, not a 500
// ---------------------------------------------------------------------------
//
// `?q=a&q=b` parses to an ARRAY. An array reaching a sqlite bind or an execFile argv
// is a TypeError, which the async wrapper turns into a 500 carrying an internal
// message — for a request that is simply malformed. Every one of these used to do that.

test('repeated transcript query params are collapsed, not passed through as arrays', async () => {
  const { app, cleanup } = routeModules();
  try {
    await serving(app, async (get) => {
      const cases = [
        '/transcripts/search?q=alpha&q=beta',
        '/transcripts/search?q=alpha&role=user&role=assistant',
        '/transcripts/search?q=alpha&session=x&session=y',
        '/transcripts/search?q=alpha&order=rank&order=recent',
        '/transcripts/search?q=alpha&limit=5&limit=9',
        '/transcripts/search?q=alpha&since=1&since=2',
      ];
      for (const route of cases) {
        const { status } = await bothPrefixes(get, route);
        assert.equal(status, 200, `${route} answered ${status} — an array reached the query layer`);
      }
    });
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// The reindex queue coalesces
// ---------------------------------------------------------------------------
//
// Stop / SubagentStop / SessionEnd all enqueue a reindex, and a session running
// parallel subagents fires a burst of them. The queue was an array, so a burst of N
// hooks did N index passes over the same file — and indexing is incremental and
// idempotent, so every pass after the first was pure re-stat work. A Set of session
// ids is the right shape: whatever arrives while a pass is in flight collapses into
// the single follow-up pass that pass is owed.

test('a burst of Stop hooks collapses into one follow-up index pass', async () => {
  const manager = /** @type {any} */ (new EventEmitter());
  const session = { id: 's1' };
  manager.get = (id) => (id === 's1' ? session : null);
  manager.all = () => [];

  const app = express();
  const api = express.Router();
  app.use('/api', api);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-queue-'));
  const { index } = transcriptRoutes.register(api, { manager, cfg: { _stateDir: stateDir } });

  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  index.index = /** @type {any} */ (async (/** @type {any} */ s) => { calls.push(s.id); await gate; return { ok: true }; });

  // Three hooks with no await between them: the first starts a pass, the other two
  // land while it is in flight.
  for (const event of ['Stop', 'SubagentStop', 'SessionEnd']) manager.emit('hook', { id: 's1', event });
  assert.equal(calls.length, 1, 'the first hook starts a pass; the rest must not each start their own');

  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(calls.length, 2, 'the two queued hooks collapse into ONE follow-up pass, not two');
  index.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('a hook for an event that is not a reindex trigger enqueues nothing', async () => {
  const manager = /** @type {any} */ (new EventEmitter());
  manager.get = () => ({ id: 's1' });
  manager.all = () => [];
  const app = express();
  const api = express.Router();
  app.use('/api', api);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-queue-'));
  const { index } = transcriptRoutes.register(api, { manager, cfg: { _stateDir: stateDir } });

  const calls = [];
  index.index = /** @type {any} */ (async (/** @type {any} */ s) => { calls.push(s.id); return { ok: true }; });
  for (const event of ['PreToolUse', 'Notification', 'SessionStart']) manager.emit('hook', { id: 's1', event });
  assert.deepEqual(calls, [], 'every tool call must not re-stat the transcript');

  index.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
