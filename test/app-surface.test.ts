/*
 * The whole HTTP surface, built the way the daemon builds it.
 *
 * test/api-routing.test.ts assembles a MINIATURE app out of the three route modules
 * that were extractable at the time, and reconstructs the mount order by hand. That is
 * still the right shape for driving those modules against deliberately hostile fakes —
 * but it can only ever cover the routes that already live in modules, and its copy of
 * the mount order can drift from the daemon's without anything failing.
 *
 * This file is the other half: server/app.ts's buildApp() with REAL collaborators
 * (against a temp state directory, so nothing is spawned and nothing of the user's is
 * touched), and every assertion below enumerated out of the router the app actually
 * built. A route added tomorrow is covered tomorrow, by nobody remembering anything.
 *
 * What it pins:
 *   · the mount ORDER, which is load-bearing and was previously only prose
 *   · every route answering identically under /api and /api/v1
 *   · every route refusing an unauthenticated request with a 401 — not a 200, and not
 *     the SPA document
 *   · exactly which of the mounted surfaces is reachable without a token, since
 *     "/hook/:event is the deliberate exception" is a claim worth failing on
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type express from 'express';
import { buildApp } from '../server/app.ts';
import * as configMod from '../server/config.ts';
import { createForge } from '../server/forge.ts';
import { createIdentity } from '../server/identity.ts';
import { Runner } from '../server/runner.ts';
import { createGuard } from '../server/security.ts';
import { Servers } from '../server/servers.ts';
import { SessionManager } from '../server/sessions.ts';
import { createState } from '../server/state.ts';
import * as webui from '../server/webui.ts';
import { muxStub, present, session as makeSession } from './helpers.ts';
import type { Config } from '../server/types.ts';

const TOKEN = 'a'.repeat(64);
/** Stands in for every :param. Nothing in the fixtures answers to it, so routes bail early. */
const SENTINEL = 'zz-nothing-here';

// ---------------------------------------------------------------------------
// the app under test
// ---------------------------------------------------------------------------

/**
 * The real app, with real collaborators, pointed at throwaway directories.
 *
 * Real rather than faked on purpose. Every one of these constructors is a few file
 * reads against `_stateDir` — nothing spawns a process until a route asks it to, and
 * with an empty repo scan and no sessions every route below bails before it would.
 * Fakes here would only be a second description of the daemon's wiring, which is the
 * thing this file exists to stop.
 */
function buildTestApp() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-surface-'));
  // A client build the resolver will accept. The placeholder proves the document goes
  // through the injector rather than out of the static mount; `bundle.js` is a stand-in
  // for the hashed assets that mount serves.
  const uiRoot = path.join(stateDir, 'ui');
  fs.mkdirSync(path.join(uiRoot, 'client', 'build'), { recursive: true });
  fs.writeFileSync(
    path.join(uiRoot, 'client', 'build', 'index.html'),
    `<!doctype html><script>window.WTS_TOKEN=${JSON.stringify(webui.PLACEHOLDER)}</script>`,
  );
  fs.writeFileSync(path.join(uiRoot, 'client', 'build', 'bundle.js'), 'export const ui = 1;\n');

  const cfg: Config = {
    ...configMod.defaults(),
    baseDirs: [],
    // Port 0 so the guard's port check is "the hostname is the check" (see security.ts)
    // and the ephemeral listen port below cannot make every request a forbidden host.
    web: { port: 0, host: '127.0.0.1' },
    _stateDir: stateDir,
    _file: path.join(stateDir, 'config.json'),
    _token: TOKEN,
  };

  const identity = createIdentity(cfg);
  const manager = new SessionManager(cfg, muxStub(), identity);
  const servers = new Servers(cfg, identity);
  const runner = new Runner(stateDir);
  const state = createState({
    cfg,
    manager,
    servers,
    mux: null,
    identity,
    repos: () => [],
    running: () => new Map(),
    runs: () => runner.runs,
  });
  // `providers: []` — no gh/glab lookup is ever attempted, so the forge routes answer
  // from their own guards on a machine that has neither CLI.
  const forge = createForge({ cfg, manager, resolveGroup: state.resolveGroup, providers: [] });

  const app = buildApp({
    cfg,
    saveConfig: () => {},
    guard: createGuard({ cfg, token: TOKEN }),
    ui: webui.resolve(uiRoot),
    manager,
    servers,
    runner,
    identity,
    forge,
    repos: () => [],
    running: () => new Map(),
    buildState: state.buildState,
    resolveGroup: state.resolveGroup,
    conflictsFor: state.conflictsFor,
    subscribe: () => () => {},
    attentionSeen: () => {},
    rescan: async () => {},
    refreshRunning: async () => {},
    broadcastTopology: () => {},
    scheduleBroadcast: () => {},
    forgetFeature: () => {},
    onEventsSubscribed: () => {},
    onCommit: () => {},
  });

  return {
    app,
    manager,
    cleanup: () => {
      (app.locals.transcriptIndex as { close(): void }).close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// asking the router what it mounted
// ---------------------------------------------------------------------------
//
// express@5 keeps no copy of the string a layer was mounted with — `layer.path` is the
// path of the request being matched, and is undefined between requests. What it does
// keep is the MATCHER, so a prefix can be proven rather than read: `matches('/api')` is
// the layer answering for itself. Everything below is derived from the live stack, so
// there is no second list to keep in step.

interface Layer {
  name: string;
  matchers: Array<(p: string) => unknown>;
  /** `path` is an ARRAY when the route was registered for several — `app.get(['/', '/index.html'])`. */
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle: { stack?: Layer[] };
}

const pathsOf = (route: NonNullable<Layer['route']>): string[] =>
  Array.isArray(route.path) ? route.path : [route.path];

/** One mounted endpoint: the verb and the path, as the router holds them. */
interface Endpoint {
  method: string;
  path: string;
}

const stackOf = (app: express.Express): Layer[] =>
  (app as unknown as { router: { stack: Layer[] } }).router.stack;

const matches = (l: Layer, p: string): boolean => l.matchers.some((m) => !!m(p));

/** The routes a layer's sub-router holds, flattened to one entry per verb. */
function endpointsOf(router: Layer): Endpoint[] {
  const out: Endpoint[] = [];
  for (const l of router.handle.stack || []) {
    if (!l.route) continue;
    for (const [method, on] of Object.entries(l.route.methods)) {
      if (!on) continue;
      for (const p of pathsOf(l.route)) out.push({ method: method.toUpperCase(), path: p });
    }
  }
  return out;
}

/** The one router mounted under /api — the same object is mounted again at /api/v1. */
function apiRouter(app: express.Express): Layer {
  const found = stackOf(app).filter((l) => !l.route && !!l.handle.stack && matches(l, '/api'));
  assert.ok(found.length >= 1, 'the API router is mounted');
  return found[0];
}

/** Fill every `:param` with the sentinel, so a path from the router is requestable. */
const concrete = (p: string): string => p.replace(/:[^/]+/g, SENTINEL);

// ---------------------------------------------------------------------------
// driving it
// ---------------------------------------------------------------------------

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

/** An authenticated request with an empty JSON body — enough to reach any handler. */
const authed = (method: string): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', 'x-wts-token': TOKEN },
  ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
});

const anonymous = (method: string): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
});

/*
 * /events is a server-sent-event stream: it answers headers and then never ends, so a
 * plain fetch of its body would hang the run. It is not skipped — it is compared on the
 * half a stream HAS (status and headers) and then aborted, which is the whole of what
 * "the same route under both prefixes" can mean for it.
 */
const STREAMING = new Set(['/events']);

// ---------------------------------------------------------------------------

test('the mount order the daemon depends on is the mount order it has', () => {
  const { app, cleanup } = buildTestApp();
  try {
    const layers = stackOf(app);
    const described = layers.map((l) => {
      if (l.route) return `${Object.keys(l.route.methods).join('+')} ${pathsOf(l.route).join(',')}`;
      if (l.handle.stack)
        return `router@${matches(l, '/api/v1') && !matches(l, '/api') ? '/api/v1' : '/api'}`;
      return l.name;
    });
    /*
     * Every line of this is a decision with a failure behind it, and the order is the
     * decision:
     *   browser      the Host/Origin allowlist runs BEFORE the body parsers, so a
     *                rejected request never makes us buffer 8 MB of its JSON
     *   handle /     the document, served by the injector — never by serveStatic, which
     *                is mounted after it with index:false for exactly that reason
     *   authed       on the /api PREFIX, so one line covers both mounts of the router
     *   router x2    the same router at both prefixes: that is what makes them equal
     *   /hook/:event outside /api on purpose (see server/routes-hook.ts)
     *   GET /{*splat} the SPA fallback, which answers any GET and so must be last
     *   handler      crash.routeErrors(), the net everything above falls into
     */
    assert.deepEqual(described, [
      'browser',
      'jsonParser',
      'textParser',
      'get /,/index.html',
      'serveStatic',
      'authed',
      'router@/api',
      'router@/api/v1',
      'post /hook/:event',
      'get /{*splat}',
      'handler',
    ]);
  } finally {
    cleanup();
  }
});

test('every route the app mounts answers identically under /api and /api/v1', async () => {
  const { app, cleanup } = buildTestApp();
  try {
    const endpoints = endpointsOf(apiRouter(app));
    assert.ok(endpoints.length > 40, `expected the whole API surface, enumerated ${endpoints.length}`);

    await serving(app, async (get) => {
      for (const { method, path: routePath } of endpoints) {
        const target = concrete(routePath);
        if (STREAMING.has(routePath)) {
          const heads = [];
          for (const prefix of ['/api', '/api/v1']) {
            const ac = new AbortController();
            const r = await get(prefix + target, { ...authed(method), signal: ac.signal });
            heads.push(`${r.status} ${r.headers.get('content-type')}`);
            ac.abort();
          }
          assert.equal(heads[0], heads[1], `${method} ${routePath}: same stream headers under both`);
          continue;
        }
        const un = await get(`/api${target}`, authed(method));
        const v1 = await get(`/api/v1${target}`, authed(method));
        assert.equal(un.status, v1.status, `${method} ${routePath}: same status under both prefixes`);
        assert.equal(
          await un.text(),
          await v1.text(),
          `${method} ${routePath}: same body under both prefixes`,
        );
        /*
         * Nothing here is expected to be well-formed — the fixtures hold no repos and no
         * sessions, so almost every route answers its own 400 or 404. What must never
         * happen is a 500: express@5 routes a thrown handler into crash.routeErrors(),
         * and a route that throws on an empty body is a route that would throw on a
         * malformed one from a real client.
         */
        assert.ok(un.status < 500, `${method} ${routePath}: answered ${un.status} for an empty body`);
      }
    });
  } finally {
    cleanup();
  }
});

test('every mounted API path refuses an unauthenticated request — 401, and not the SPA document', async () => {
  const { app, cleanup } = buildTestApp();
  try {
    const endpoints = endpointsOf(apiRouter(app));
    await serving(app, async (get) => {
      for (const { method, path: routePath } of endpoints) {
        const target = concrete(routePath);
        for (const prefix of ['/api', '/api/v1']) {
          const r = await get(prefix + target, anonymous(method));
          assert.equal(r.status, 401, `${method} ${prefix}${routePath} must not answer ${r.status}`);
          /*
           * The SPA fallback answers any GET and is mounted after these. It skips /api
           * paths deliberately — an unknown API path has to stay a refusal SwiftBar,
           * Alfred and the CLI can read, not 200 text/html they would try to parse. This
           * is the assertion that keeps that true.
           */
          assert.match(
            String(r.headers.get('content-type')),
            /application\/json/,
            `${method} ${prefix}${routePath} answered a document, not a refusal`,
          );
          assert.deepEqual(await r.json(), { error: 'missing or invalid token' });
        }
      }
    });
  } finally {
    cleanup();
  }
});

/*
 * ---- the auth surface -------------------------------------------------------
 *
 * Everything not under /api, enumerated from the same stack, and what each one does for
 * a caller with no token. Written as a single assertion over the whole surface rather
 * than one test per path, because the interesting claim is the EXHAUSTIVE one: the hook
 * receiver and the asset mount are the only two things a tokenless local process can
 * reach, and that is a deliberate pair rather than an oversight.
 */
test('the only unauthenticated surfaces are the hook receiver and the asset mount', async () => {
  const { app, manager, cleanup } = buildTestApp();
  try {
    // Everything mounted outside the API router, as the stack reports it.
    const outside = stackOf(app)
      .filter((l) => l.route || l.name === 'serveStatic')
      .map((l) => (l.route ? pathsOf(l.route).join(',') : 'serveStatic'));
    assert.deepEqual(
      outside,
      ['/,/index.html', 'serveStatic', '/hook/:event', '/{*splat}'],
      'the non-API surface is the document, its assets, the hook receiver and the SPA fallback',
    );

    /*
     * A session that predates token-bearing settings files. Its generated settings file
     * was written before the token existed, so its claude process POSTs a tokenless hook
     * URL and cannot be told otherwise without killing it — `hookAuth` unset is what
     * grandfathers it in. Injected rather than created: create() launches a real
     * multiplexer session, and this is a test about a header that is not there.
     */
    const grandfathered = makeSession({ id: 'old-1', hookAuth: undefined });
    const tokenAware = makeSession({ id: 'new-1', hookAuth: true });
    manager.sessions.set('old-1', grandfathered);
    manager.sessions.set('new-1', tokenAware);

    await serving(app, async (get) => {
      // The document hands OUT the token, so it is gated on the token: before that gate,
      // `curl 127.0.0.1:7788/` printed the live token to any process on the machine.
      for (const doc of ['/', '/index.html', '/review/deep/link']) {
        const r = await get(doc, anonymous('GET'));
        assert.equal(r.status, 401, `${doc} must not hand out the shell`);
        const html = await r.text();
        assert.match(html, /Token required/, `${doc} explains itself rather than bare-401ing the whole UI`);
        assert.ok(!html.includes(TOKEN), `${doc} must not leak the token into its challenge`);
      }

      // ...and with the token it is the injected document, not the file on disk.
      const withToken = await get('/', { headers: { 'x-wts-token': TOKEN } });
      assert.equal(withToken.status, 200);
      const shell = await withToken.text();
      assert.ok(shell.includes(TOKEN), 'the token reaches the tab the only way it can');
      assert.ok(!shell.includes(webui.PLACEHOLDER), 'and the placeholder was substituted, not shipped');

      /*
       * The asset mount is unauthenticated, and that is the deliberate half of the pair:
       * the bundle carries no secret (the token is injected into the DOCUMENT, which is
       * gated above), and gating hashed assets would buy nothing while breaking the
       * browser cache. Asserted rather than assumed — if this ever starts 401ing, the UI
       * is broken; if the document ever stops, the token is public.
       */
      const asset = await get('/bundle.js', anonymous('GET'));
      assert.equal(asset.status, 200, 'the SPA bundle is served to the tab before it has a cookie');

      // The hook receiver: the one route a tokenless caller may drive, and only for a
      // session whose settings file predates the token.
      const applied = await get('/hook/Stop?wts=old-1', anonymous('POST'));
      assert.equal(applied.status, 200);
      assert.deepEqual(await applied.json(), { ok: true, applied: true });

      // The exemption is per-session and self-clearing: once a session's settings file
      // has been rewritten WITH the token, it no longer gets in without one.
      const refused = await get('/hook/Stop?wts=new-1', anonymous('POST'));
      assert.equal(refused.status, 401, 'a token-aware session must present the token');

      // And it is not a way in for anyone else: an unknown session is just a 401.
      const unknown = await get(`/hook/Stop?wts=${SENTINEL}`, anonymous('POST'));
      assert.equal(unknown.status, 401);
      const anonymousHook = await get('/hook/Stop', anonymous('POST'));
      assert.equal(anonymousHook.status, 401, 'and neither is naming no session at all');

      // With the token, an unknown session is a REPORTED drop rather than a silent
      // ok:true — the failure that made a card go quiet with nothing anywhere saying why.
      const dropped = await get(`/hook/Stop?wts=${SENTINEL}`, authed('POST'));
      assert.deepEqual(await dropped.json(), { ok: true, applied: false, reason: 'unknown session' });
    });
  } finally {
    cleanup();
  }
});
