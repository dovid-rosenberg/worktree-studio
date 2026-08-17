// The route-module convention and the API versioning that rides on it: feature
// modules call register(app, deps) against ONE router, and server.ts mounts that
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
import * as orchestrator from '../server/orchestrator.ts';
import { createForge } from '../server/forge.ts';
import { createIdentity } from '../server/identity.ts';
import * as crash from '../server/crash.ts';
import { EventEmitter } from 'node:events';
import * as routesReview from '../server/routes-review.ts';
import * as transcriptRoutes from '../server/transcript-routes.ts';
import type { TranscriptManager } from '../server/transcript-routes.ts';
import type { AddressInfo } from 'net';
import { requireBody, requireFeature, requireRepo, requireSession } from '../server/util.ts';
import { body as jsonBody, present, session as makeSession } from './helpers.ts';
import type { JsonBody } from './helpers.ts';

// server.ts mounts this last, after every route. The route modules used to carry their
// own async wrapper, so a harness that omitted it still got JSON out of a throwing
// handler; now the error policy belongs to the app, and a miniature that leaves it out
// is testing a wiring the daemon does not have. Silent, because the deliberately
// minimal fakes below make some routes throw on purpose.
const mountErrors = (app: express.Express) => app.use(crash.routeErrors({ log: () => {} }));

// The real (default) feature-identity resolver — slot keys come from it in
// production, so the fake derives them the same way rather than hardcoding one.
const identity = createIdentity({});

const WT = (name: string) => `/code/api/.worktrees/${name}`;

// Records what the orchestrator asked of the collaborators it was handed.
// A feature member as these routes read it — the same slice orchestrator.ts's own
// `Member` names. Spelled here rather than imported because that type is internal to
// the module under test, and a fixture that had to match it exactly would defeat the
// point of the module declaring a narrow one.
interface Member {
  repo: string;
  path: string;
  branch?: string | null;
  wtname?: string;
  running?: boolean;
  canStart?: boolean;
  session?: { id: string } | null;
}
interface HarnessOpts {
  group?: { name: string; members: Member[] };
  flat?: Member[];
  conflicts?: Member[];
  allocError?: string | null;
  startError?: string | null;
  /** What servers.start() reports about the ports binding — see servers.ts StartResult. */
  startListening?: boolean;
  /** Ports the worktree turned out to hold instead of the expected ones. */
  boundElsewhere?: number[];
  /** Feature names that still have something listening, so their slot must be held. */
  stillRunning?: string[];
}
function harness({
  group,
  flat = [],
  conflicts = [],
  allocError = null,
  startError = null,
  startListening,
  boundElsewhere,
  stillRunning = [],
}: HarnessOpts = {}) {
  const calls = {
    stopped: [] as Array<[string, string]>,
    started: [] as Array<[string, string]>,
    released: [] as string[],
    /** Features whose slot was deliberately NOT freed because something still runs. */
    heldSlots: [] as string[],
    allocated: [] as string[],
    broadcasts: 0,
  };
  const servers = {
    identity,
    featureFor: (p: string) => identity.ofPath(p),
    allocSlotFor: (f: string) => {
      calls.allocated.push(f);
      return allocError ? { error: allocError } : { slot: 0 };
    },
    releaseSlot: (f: string) => {
      calls.released.push(f);
    },
    /*
     * The guarded release. `stillRunning` lets a test say "a member of this feature is
     * still listening" and assert the slot is NOT freed — the bug being pinned is a slot
     * going back in the pool while something still holds its ports.
     */
    releaseSlotIfIdle: (f: string) => {
      if (stillRunning.includes(f)) {
        calls.heldSlots.push(f);
        return false;
      }
      calls.released.push(f);
      return true;
    },
    launchOpts: () => ({ env: {}, ports: [] }),
    stop: async (repo: string, p: string) => {
      calls.stopped.push([repo, p]);
      // `stillListening` is the whole point of the type: a stop that did not stop.
      return { ok: true as const, killed: true, stillListening: [] };
    },
    start: async (repo: string, p: string) => {
      calls.started.push([repo, p]);
      return startError
        ? { ok: false, error: startError }
        : { ok: true, listening: startListening, boundElsewhere };
    },
    // Mirrors servers.startAll: allocate every slot first (so a slot failure spawns
    // nothing), then launch. The fake records the same calls the old inline loop did.
    startAll: async (targets: Array<{ repo: string; worktreePath: string }>) => {
      for (const t2 of targets) {
        calls.allocated.push(identity.ofPath(t2.worktreePath));
        if (allocError) return { ok: false as const, slotError: allocError };
      }
      const results = targets.map((t2) => {
        calls.started.push([t2.repo, t2.worktreePath] as [string, string]);
        return startError
          ? { repo: t2.repo, ok: false, error: startError }
          : { repo: t2.repo, ok: true, listening: startListening, boundElsewhere };
      });
      return { ok: true as const, results };
    },
    restart: async (repo: string, p: string) => {
      calls.started.push([repo, p]);
      return startError ? { ok: false, error: startError } : { ok: true };
    },
  };
  const deps = {
    cfg: { editors: {}, defaultEditor: '' },
    servers,
    // Only what the routes under test call; adopt/attachRepo are exercised elsewhere,
    // and a route that reached for one here would be a wiring bug worth failing on.
    manager: {
      get: () => null,
      deactivate: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      sessionForWorktree: () => null,
      adopt: async () => null,
      attachRepo: async () => ({ ok: true }),
    },
    repos: () => [{ name: 'api', path: '/code/api' }],
    resolveGroup: async (name: string) =>
      group && name === group.name ? { group, flat } : { group: null, flat: [] },
    conflictsFor: () => conflicts,
    refreshRunning: async () => {},
    // The fake decides "still running" by feature name (see stillRunning), so the map
    // itself is never read — only its identity as the argument.
    running: () => new Map<string, { pid: number; ports: number[] }>(),
    scheduleBroadcast: () => {
      calls.broadcasts++;
    },
    rescan: async () => {},
  };

  const app = express();
  app.use(express.json());
  const api = express.Router();
  app.use('/api', api);
  app.use('/api/v1', api);
  orchestrator.register(api, deps);
  // The forge reads a narrower slice than the orchestrator does: a session's repos,
  // and a group whose members each carry a branch.
  createForge({
    manager: { get: () => undefined },
    resolveGroup: async (name: string) =>
      group && name === group.name
        ? {
            group: {
              members: group.members.map((m) => ({ repo: m.repo, path: m.path, branch: m.branch ?? null })),
            },
          }
        : { group: null },
    providers: [],
  }).register(api);
  mountErrors(app);
  return { app, calls };
}

// Serve `app` for the duration of fn, handing it a (path, init) => Response fetcher.
type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
async function serving<T>(app: express.Express, fn: (get: Fetcher) => Promise<T>): Promise<T> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(present(server.address()) as AddressInfo).port}`;
  try {
    return await fn((p, init) => fetch(base + p, init));
  } finally {
    server.close();
  }
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// Call the same route under both prefixes and assert the answers match.
async function bothPrefixes(
  get: Fetcher,
  route: string,
  init?: RequestInit,
): Promise<{ status: number; body: JsonBody }> {
  const un = await get(`/api${route}`, init);
  const v1 = await get(`/api/v1${route}`, init);
  const [a, b] = [await jsonBody(un), await jsonBody(v1)];
  assert.equal(un.status, v1.status, `${route}: same status under both prefixes`);
  assert.deepEqual(a, b, `${route}: same body under both prefixes`);
  return { status: un.status, body: a };
}

const FEATURE = {
  name: 'feat-a',
  members: [
    { repo: 'api', path: WT('feat-a'), branch: 'feature/a', wtname: 'feat-a', running: true, canStart: true },
    {
      repo: 'fe',
      path: '/code/fe/.worktrees/feat-a',
      branch: 'feature/a',
      wtname: 'feat-a',
      running: false,
      canStart: true,
    },
  ],
};

test('every group route answers identically under /api and /api/v1', async () => {
  for (const route of [
    '/group/start',
    '/group/stop',
    '/group/restart',
    '/group/close',
    '/group/delete',
    '/group/session',
    '/group/pr',
  ]) {
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

/*
 * ---- the route preamble, once -----------------------------------------------
 *
 * `resolveGroup` + `if (!g) 404`, `repos().find` + `if (!repoObj)`, and the body check
 * the three /servers/* routes shared were spelled out at some twenty-five call sites,
 * and one of them was missing its guard — POST /group/session read `pRepo.path` for a
 * repo the scan cache had not seen, which is a TypeError, i.e. a 500 carrying an
 * internal message for what is the caller's own bad input.
 *
 * requireFeature / requireRepo / requireSession / requireBody are that preamble. The
 * tests below cover both halves: every group verb really goes through the shared 404,
 * and the guards themselves answer what they promise.
 */

test('every group verb answers the SAME 404, with a reason, for a feature that is not there', async () => {
  // One shared helper, so this cannot be true of six routes and false of the seventh —
  // which is how /group/session came to be the one without a repo guard.
  for (const route of [
    '/group/start',
    '/group/stop',
    '/group/restart',
    '/group/open',
    '/group/close',
    '/group/delete',
    '/group/session',
  ]) {
    const { app } = harness({ group: FEATURE });
    await serving(app, async (get) => {
      const { status, body } = await bothPrefixes(get, route, post({ group: 'nope' }));
      assert.equal(status, 404, `${route} answered ${status} for an unknown feature`);
      assert.deepEqual(body, { error: 'no such feature' }, `${route} must say why it refused`);
    });
  }
});

test('a feature naming a repo the scan cache has not seen is a 400, not a 500', async () => {
  /*
   * The exact shape of the bug: the feature resolves, so the 404 above does not fire, and
   * its primary member names a repo `repos()` does not hold. That went straight to
   * `pRepo.path` and threw. The answer has to be the caller's 400, and it has to name the
   * repo — `unknown repo ''` is the first-run symptom (no baseDirs, so an empty picker),
   * and a message without the name cannot tell you that is what happened.
   */
  const ghost = {
    name: 'feat-ghost',
    members: [{ repo: 'ghost', path: WT('feat-ghost'), branch: 'feature/ghost', wtname: 'feat-ghost' }],
  };
  const { app } = harness({ group: ghost });
  await serving(app, async (get) => {
    const { status, body } = await bothPrefixes(get, '/group/session', post({ group: 'feat-ghost' }));
    assert.equal(status, 400, `answered ${status} — a missing repo reached a property access`);
    assert.deepEqual(body, { error: "unknown repo 'ghost'" });
  });
});

// The guards on their own, over a real express app: the group routes above prove they are
// wired in, these prove what they answer. Registered against handlers that do nothing but
// call the guard, because what is being pinned is the guard's contract, not a route's.
function guardApp() {
  const app = express();
  app.use(express.json());
  const api = express.Router();
  app.use('/api', api);
  const sessions: Record<string, { id: string }> = { live: { id: 'live' } };

  api.post('/g/feature', async (req, res) => {
    const resolve = async (name: string) => (name === 'known' ? { group: { members: [] } } : { group: null });
    const found = await requireFeature(res, resolve, req.body?.group);
    if (!found.ok) return;
    res.json({ reached: true });
  });
  api.post('/g/repo', (req, res) => {
    const found = requireRepo(res, [{ name: 'api', path: '/code/api' }], req.body?.repo);
    if (!found.ok) return;
    res.json({ reached: found.value.path });
  });
  api.post('/g/session', (req, res) => {
    const found = requireSession(res, (id) => sessions[id], String(req.body?.id ?? ''));
    if (!found.ok) return;
    res.json({ reached: found.value.id });
  });
  api.post('/g/body', (req, res) => {
    const asked = requireBody(res, req.body, ['repo', 'worktreePath']);
    if (!asked.ok) return;
    res.json({ reached: asked.value });
  });
  api.post('/g/body-one', (req, res) => {
    const asked = requireBody(res, req.body, ['worktreePath']);
    if (!asked.ok) return;
    res.json({ reached: asked.value });
  });
  mountErrors(app);
  return app;
}

test('requireFeature: a feature that is not there is a 404 that says so', async () => {
  await serving(guardApp(), async (get) => {
    const miss = await get('/api/g/feature', post({ group: 'nope' }));
    assert.equal(miss.status, 404);
    assert.deepEqual(await jsonBody(miss), { error: 'no such feature' });
    // A name off the wire is not a string. The coercion lives in the guard so that no
    // call site has to remember String(), which is how one of them came to skip it.
    const coerced = await get('/api/g/feature', post({ group: ['known', 'other'] }));
    assert.equal(coerced.status, 404, 'an array is not the feature named "known"');
    const hit = await get('/api/g/feature', post({ group: 'known' }));
    assert.deepEqual(await jsonBody(hit), { reached: true });
  });
});

test('requireRepo: an unknown repo is a 400 naming what was asked for', async () => {
  await serving(guardApp(), async (get) => {
    const miss = await get('/api/g/repo', post({ repo: 'nope' }));
    assert.equal(miss.status, 400, 'unresolvable input, which docs/api.md states is a 400');
    assert.deepEqual(await jsonBody(miss), { error: "unknown repo 'nope'" });
    // The empty-picker case, which is what a first run with no baseDirs looks like.
    const unnamed = await get('/api/g/repo', post({}));
    assert.deepEqual(await jsonBody(unnamed), { error: "unknown repo ''" });
    const hit = await get('/api/g/repo', post({ repo: 'api' }));
    assert.deepEqual(await jsonBody(hit), { reached: '/code/api' });
  });
});

test('requireSession: an unknown session is a 404, and never a reasonless failure', async () => {
  await serving(guardApp(), async (get) => {
    const miss = await get('/api/g/session', post({ id: 'gone' }));
    assert.equal(miss.status, 404, 'the status docs/api.md states for a named thing that is not there');
    assert.deepEqual(
      await jsonBody(miss),
      { error: 'no such session' },
      'this is the half of the bare `{ok:false}` the route layer can fix on its own',
    );
    const hit = await get('/api/g/session', post({ id: 'live' }));
    assert.deepEqual(await jsonBody(hit), { reached: 'live' });
  });
});

test('requireBody: a missing field is a 400 stating the whole contract', async () => {
  await serving(guardApp(), async (get) => {
    for (const body of [{}, { repo: 'api' }, { worktreePath: '/w' }, { repo: '  ', worktreePath: '/w' }]) {
      const r = await get('/api/g/body', post(body));
      assert.equal(r.status, 400, `${JSON.stringify(body)} was accepted`);
      // Every field, not the missing one: the message is the route's contract, and it is
      // the message these three routes already carried.
      assert.deepEqual(await jsonBody(r), { ok: false, error: 'repo and worktreePath are required' });
    }
    const one = await get('/api/g/body-one', post({}));
    assert.deepEqual(await jsonBody(one), { ok: false, error: 'worktreePath is required' }, 'and it reads');

    /*
     * Only a real string counts. `String(req.body?.x || '')` — what these routes did —
     * turns an object into "[object Object]" and an array into "a,b", and DELETE
     * /worktrees was fixed once already for handing exactly that kind of value to a git
     * argv and reporting the failure with a 200.
     */
    for (const bad of [{ a: 1 }, ['/w'], 7, true, null]) {
      const r = await get('/api/g/body', post({ repo: 'api', worktreePath: bad }));
      assert.equal(r.status, 400, `${JSON.stringify(bad)} was coerced into a path`);
    }
    const ok = await get('/api/g/body', post({ repo: ' api ', worktreePath: '/w' }));
    assert.deepEqual(await jsonBody(ok), { reached: { repo: 'api', worktreePath: '/w' } }, 'trimmed');
  });
});

test('/sessions/:id/ci is registered under both prefixes', async () => {
  const { app } = harness({ group: FEATURE });
  await serving(app, async (get) => {
    const { status, body } = await bothPrefixes(get, '/sessions/nope/ci');
    assert.equal(status, 404);
    assert.deepEqual(body, { error: 'no such session' }, "the module's own 404, not express's");
  });
});

test("group/stop stops only running members and frees every member's slot", async () => {
  const { app, calls } = harness({ group: FEATURE });
  await serving(app, async (get) => {
    const r = await get('/api/v1/group/stop', post({ group: 'feat-a' }));
    // Was a hardcoded `{ok: true}`, which is why a server that ignored SIGTERM and kept
    // its port was reported as stopped. The counts are what make `ok` mean something.
    assert.deepEqual(await r.json(), { ok: true, stopped: 1, total: 1 });
  });
  assert.deepEqual(calls.stopped, [['api', WT('feat-a')]], 'the stopped member is not re-stopped');
  assert.deepEqual(
    calls.released,
    ['feat-a', 'feat-a'],
    "the whole stack is down → the feature's slot is freed",
  );
});

test('group/start starts the members that can start and are not already running', async () => {
  const { app, calls } = harness({ group: FEATURE });
  await serving(app, async (get) => {
    const r = await get('/api/v1/group/start', post({ group: 'feat-a' }));
    assert.deepEqual(await r.json(), { ok: true, started: 1, total: 1, skipped: [], failures: [] });
  });
  assert.deepEqual(calls.started, [['fe', '/code/fe/.worktrees/feat-a']]);
  assert.deepEqual(
    calls.allocated,
    ['feat-a'],
    "the slot is keyed on the member's .worktrees/<name> basename",
  );
});

test('group/start asks for confirmation before stopping a conflicting worktree', async () => {
  const conflict = { repo: 'fe', path: '/code/fe/.worktrees/other', running: true };
  const { app, calls } = harness({ group: FEATURE, conflicts: [conflict] });
  await serving(app, async (get) => {
    const r = await get('/api/v1/group/start', post({ group: 'feat-a' }));
    const body = await jsonBody(r);
    assert.equal(body.needsConfirm, true);
    assert.deepEqual(body.conflicts, [conflict]);
    assert.equal(body.willStart.length, 1);
  });
  assert.deepEqual(calls.started, [], 'nothing is launched until the client confirms');
  assert.deepEqual(calls.stopped, [], 'and nothing is stopped either');
});

/*
 * Confirming "stop the conflicts" has to give their slots back before asking for one.
 *
 * The stop loop released nothing, so with the slots full, confirming the stop took the
 * conflicting feature down and THEN failed to allocate — 409 "no free concurrency slot",
 * one stack stopped, nothing started, and an error describing a state the request had
 * just created. startAll's own comment promises the opposite: every slot allocated
 * before anything is launched, so a slot failure spawns nothing.
 */
test("group/start frees a stopped conflict's slot before allocating its own", async () => {
  const conflict = { repo: 'fe', path: '/code/fe/.worktrees/other', running: true };
  const { app, calls } = harness({ group: FEATURE, conflicts: [conflict] });
  await serving(app, async (get) => {
    const r = await get('/api/v1/group/start', post({ group: 'feat-a', stopConflicts: true }));
    assert.equal(r.status, 200);
  });
  assert.deepEqual(calls.stopped, [['fe', '/code/fe/.worktrees/other']], 'the conflict is stopped');
  assert.ok(
    calls.released.includes('other'),
    `the stopped conflict's slot must go back in the pool, released: ${JSON.stringify(calls.released)}`,
  );
  assert.deepEqual(calls.started, [['fe', '/code/fe/.worktrees/feat-a']], 'and the feature starts');
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
    {
      repo: 'api',
      path: WT('feat-b'),
      branch: 'feature/b',
      wtname: 'feat-b',
      running: false,
      canStart: true,
    },
    {
      repo: 'fe',
      path: '/code/fe/.worktrees/feat-b',
      branch: 'feature/b',
      wtname: 'feat-b',
      running: false,
      canStart: true,
    },
  ],
};

test('group/start reports ok:false when every member failed to start', async () => {
  const { app } = harness({ group: STARTABLE, startError: 'port 3030 already in use (pid 991)' });
  await serving(app, async (get) => {
    const body = await jsonBody(await get('/api/v1/group/start', post({ group: 'feat-b' })));
    assert.equal(body.started, 0);
    assert.equal(body.total, 2);
    assert.equal(body.failures.length, 2);
    assert.equal(body.ok, false, 'a client keying on ok must not read total failure as success');
  });
});

test('group/start reports ok:false for a partial start too', async () => {
  // FEATURE has one member already running, so exactly one is attempted — and it fails.
  const { app } = harness({ group: FEATURE, startError: "no start config for repo 'fe'" });
  await serving(app, async (get) => {
    const body = await jsonBody(await get('/api/v1/group/start', post({ group: 'feat-a' })));
    assert.deepEqual(body, {
      ok: false,
      started: 0,
      total: 1,
      skipped: [],
      failures: [{ repo: 'fe', error: "no start config for repo 'fe'" }],
    });
  });
});

test('group/start with nothing to start is a no-op, not a failure', async () => {
  const allRunning = {
    name: 'feat-c',
    members: [{ repo: 'api', path: WT('feat-c'), running: true, canStart: true }],
  };
  const { app } = harness({ group: allRunning });
  await serving(app, async (get) => {
    const body = await jsonBody(await get('/api/v1/group/start', post({ group: 'feat-c' })));
    assert.deepEqual(body, { ok: true, started: 0, total: 0, skipped: [], failures: [] });
  });
});

// ---------------------------------------------------------------------------
// A member that cannot start is REPORTED, not dropped
//
// The bug these pin: `toStart` filtered on `canStart` and `total` counted `toStart`, so
// a member that could not launch vanished before anything was counted. A two-repo
// feature whose BE worktree had no node_modules — the normal state of a fresh `wt`
// worktree — answered `{ok:true, started:1, total:1, failures:[]}`, which is exactly
// what a complete success looks like. The user saw "started" and half a stack.
// ---------------------------------------------------------------------------

// One member is up, the other cannot start because its worktree has no node_modules.
const DEPS_MISSING = {
  name: 'feat-d',
  members: [
    { repo: 'api', path: WT('feat-d'), running: false, canStart: true },
    { repo: 'fe', path: '/code/fe/.worktrees/feat-d', running: false, canStart: false, depsMissing: true },
  ],
};

test('group/start names the member it could not start, and does not call that success', async () => {
  const { app, calls } = harness({ group: DEPS_MISSING });
  await serving(app, async (get) => {
    const body = await jsonBody(await get('/api/v1/group/start', post({ group: 'feat-d' })));
    assert.deepEqual(body, {
      ok: false,
      started: 1,
      total: 2,
      skipped: [{ repo: 'fe', path: '/code/fe/.worktrees/feat-d', reason: 'dependencies not installed' }],
      failures: [],
    });
  });
  assert.deepEqual(calls.started, [['api', WT('feat-d')]], 'the skipped member is still never launched');
});

test('group/start distinguishes a missing start command from missing dependencies', async () => {
  const group = {
    name: 'feat-e',
    members: [{ repo: 'docs', path: WT('feat-e'), running: false, canStart: false, noStartCmd: true }],
  };
  const { app } = harness({ group });
  await serving(app, async (get) => {
    const body = await jsonBody(await get('/api/v1/group/start', post({ group: 'feat-e' })));
    assert.equal(body.ok, false, 'a stack that started nothing is not a success');
    assert.equal(body.total, 1, 'total counts what should be up, not what was attempted');
    assert.deepEqual(body.skipped, [
      { repo: 'docs', path: WT('feat-e'), reason: 'no start command configured for this repo' },
    ]);
  });
});

test('an already-running member is not "skipped" — there is nothing to fix', async () => {
  // FEATURE's first member is running:true. Skipping it is a no-op, not a shortfall,
  // so it must not appear in `skipped` or inflate `total`.
  const { app } = harness({ group: FEATURE });
  await serving(app, async (get) => {
    const body = await jsonBody(await get('/api/v1/group/start', post({ group: 'feat-a' })));
    assert.deepEqual(body.skipped, []);
    assert.equal(body.total, 1);
    assert.equal(body.ok, true);
  });
});

test('the needsConfirm answer carries what the start will not bring up', async () => {
  const conflict = { repo: 'other', path: '/code/fe/.worktrees/other', running: true };
  const { app } = harness({ group: DEPS_MISSING, conflicts: [conflict] });
  await serving(app, async (get) => {
    const body = await jsonBody(await get('/api/v1/group/start', post({ group: 'feat-d' })));
    assert.equal(body.needsConfirm, true);
    assert.deepEqual(
      body.skipped,
      [{ repo: 'fe', path: '/code/fe/.worktrees/feat-d', reason: 'dependencies not installed' }],
      'the user agrees to stop something else knowing what will still be missing',
    );
  });
});

// ---------------------------------------------------------------------------
// "Spawned" is not "listening"
// ---------------------------------------------------------------------------

test('group/start counts a server that spawned but never bound as a failure', async () => {
  const { app } = harness({ group: STARTABLE, startListening: false });
  await serving(app, async (get) => {
    const body = await jsonBody(await get('/api/v1/group/start', post({ group: 'feat-b' })));
    assert.equal(body.started, 0, 'a process that never listened did not start');
    assert.equal(body.ok, false);
    assert.equal(body.failures.length, 2);
    assert.match(body.failures[0].error, /no port was listening/);
  });
});

test('group/start tells "up on the wrong port" apart from "not up at all"', async () => {
  // The signature of a concurrency slot the repo does not implement: Studio derived a
  // per-slot port and passed it as an env var, the repo ignored it and bound its
  // hardcoded one. The server IS running — reporting that as a dead process sends the
  // user to read a log that says "ready".
  const { app } = harness({ group: STARTABLE, startListening: false, boundElsewhere: [3030] });
  await serving(app, async (get) => {
    const body = await jsonBody(await get('/api/v1/group/start', post({ group: 'feat-b' })));
    assert.equal(body.ok, false);
    assert.match(body.failures[0].error, /started on port 3030 instead of/);
    assert.match(body.failures[0].error, /does not appear to read its configured port env var/);
  });
});

test('group/start still counts an unverifiable start — no ports is not a failure', async () => {
  // listening: undefined — the repo has no knowable ports, so nothing was checked.
  // That must not be read as "it failed to bind".
  const { app } = harness({ group: STARTABLE, startListening: undefined });
  await serving(app, async (get) => {
    const body = await jsonBody(await get('/api/v1/group/start', post({ group: 'feat-b' })));
    assert.equal(body.started, 2);
    assert.equal(body.ok, true);
  });
});

// ---------------------------------------------------------------------------
// /group/restart answers with a verdict too
// ---------------------------------------------------------------------------

test('group/restart reports what it restarted and what it skipped', async () => {
  const { app } = harness({ group: DEPS_MISSING });
  await serving(app, async (get) => {
    const body = await jsonBody(await get('/api/v1/group/restart', post({ group: 'feat-d' })));
    assert.equal(body.ok, false, 'ok was hardcoded true regardless of the outcome');
    assert.equal(body.started, 1);
    assert.equal(body.total, 2);
    assert.deepEqual(body.skipped, [
      { repo: 'fe', path: '/code/fe/.worktrees/feat-d', reason: 'dependencies not installed' },
    ]);
  });
});

test('group/restart reports ok:false when a member fails to come back', async () => {
  const { app } = harness({ group: STARTABLE, startError: 'port 3030 already in use (pid 991)' });
  await serving(app, async (get) => {
    const body = await jsonBody(await get('/api/v1/group/restart', post({ group: 'feat-b' })));
    assert.equal(body.ok, false);
    assert.equal(body.started, 0);
    assert.equal(body.failures.length, 2);
  });
});

// ---------------------------------------------------------------------------
// A slot is freed only when the feature is really down
//
// Three routes used to free slots three different ways. Only /servers/stop guarded on
// "nothing of this feature is still listening"; /group/stop and /sessions/:id/servers/stop
// released as soon as they had stopped what THEY knew about. A feature can own a worktree
// the caller never enumerated — a plain `wt` worktree joins the feature but not the
// session — so the slot went back in the pool while its ports were still held, and the
// next feature bound the same ones.
// ---------------------------------------------------------------------------

test('group/stop holds the slot when something of the feature is still listening', async () => {
  const { app, calls } = harness({ group: FEATURE, stillRunning: ['feat-a'] });
  await serving(app, async (get) => {
    await get('/api/v1/group/stop', post({ group: 'feat-a' }));
  });
  assert.deepEqual(calls.released, [], 'nothing may be freed while a member still holds its ports');
  assert.ok(calls.heldSlots.length > 0, 'and the guard is what held it');
});

test('group/stop frees the slot once the feature is quiet', async () => {
  const { app, calls } = harness({ group: FEATURE });
  await serving(app, async (get) => {
    await get('/api/v1/group/stop', post({ group: 'feat-a' }));
  });
  assert.deepEqual(calls.released, ['feat-a', 'feat-a'], 'one release attempt per member, all idle');
  assert.deepEqual(calls.heldSlots, []);
});

test('group/close guards its slot release too', async () => {
  const { app, calls } = harness({ group: FEATURE, stillRunning: ['feat-a'] });
  await serving(app, async (get) => {
    await get('/api/v1/group/close', post({ group: 'feat-a' }));
  });
  assert.deepEqual(calls.released, [], 'close released against a stale map and did not refresh at all');
});

test('group/delete frees the slot unconditionally — the worktrees are gone', async () => {
  // The one place the bare release is right: guarding would leak the slot forever if a
  // stray process still held a port from a path that no longer exists.
  const { app, calls } = harness({ group: FEATURE, stillRunning: ['feat-a'] });
  await serving(app, async (get) => {
    await get('/api/v1/group/delete', post({ group: 'feat-a' }));
  });
  assert.ok(calls.released.includes('feat-a'), 'a deleted feature always gives its slot back');
});

test('the needsConfirm answer stays ok:true — the server is asking, not failing', async () => {
  const conflict = { repo: 'fe', path: '/code/fe/.worktrees/other', running: true };
  const { app } = harness({ group: FEATURE, conflicts: [conflict] });
  await serving(app, async (get) => {
    const body = await jsonBody(await get('/api/v1/group/start', post({ group: 'feat-a' })));
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
// prefix. Both now register onto the router server.ts mounts twice, which is the only
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
  const manager: TranscriptManager = { get: () => null, all: () => [], on: () => undefined };
  routesReview.register(api, { manager, repos: () => [] });
  // A throwaway state dir, so the real ~/.local/state index is never opened.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-routing-'));
  const { index } = transcriptRoutes.register(api, { manager, cfg: { _stateDir: stateDir } });
  mountErrors(app);
  return {
    app,
    index,
    cleanup: () => {
      index.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
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
  } finally {
    cleanup();
  }
});

test('the transcript routes answer identically under /api and /api/v1', async () => {
  const { app, cleanup } = routeModules();
  try {
    await serving(app, async (get) => {
      for (const route of ['/sessions/nope/transcript', '/sessions/nope/transcript/search']) {
        const { status, body } = await bothPrefixes(get, route);
        assert.equal(status, 404);
        assert.deepEqual(body, { error: 'no such session' });
      }
      for (const route of ['/transcripts/status', '/transcripts/search']) {
        const { status } = await bothPrefixes(get, route);
        assert.equal(status, 200, `${route} is registered under both prefixes`);
      }
      const { status } = await bothPrefixes(get, '/transcripts/reindex', post({}));
      assert.equal(status, 200);
    });
  } finally {
    cleanup();
  }
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
  } finally {
    cleanup();
  }
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
  const manager = new EventEmitter() as EventEmitter & TranscriptManager;
  const s1 = makeSession({ id: 's1' });
  manager.get = (id: string) => (id === 's1' ? s1 : null);
  manager.all = () => [];

  const app = express();
  const api = express.Router();
  app.use('/api', api);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-queue-'));
  const { index } = transcriptRoutes.register(api, { manager, cfg: { _stateDir: stateDir } });

  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  index.index = async (s: { id?: string | null }) => {
    calls.push(String(s.id));
    await gate;
    return { ok: true };
  };

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
  const manager = new EventEmitter() as EventEmitter & TranscriptManager;
  manager.get = () => makeSession({ id: 's1' });
  manager.all = () => [];
  const app = express();
  const api = express.Router();
  app.use('/api', api);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-queue-'));
  const { index } = transcriptRoutes.register(api, { manager, cfg: { _stateDir: stateDir } });

  const calls: string[] = [];
  index.index = async (s: { id?: string | null }) => {
    calls.push(String(s.id));
    return { ok: true };
  };
  for (const event of ['PreToolUse', 'Notification', 'SessionStart'])
    manager.emit('hook', { id: 's1', event });
  assert.deepEqual(calls, [], 'every tool call must not re-stat the transcript');

  index.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
