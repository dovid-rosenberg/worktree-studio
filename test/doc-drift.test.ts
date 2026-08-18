/*
 * docs/api.md against the router it claims to describe.
 *
 * The reason this file exists: docs/api.md documented four routes that had been deleted
 * and omitted a dozen that had been added. Nothing failed, because nothing compared them
 * — the doc was maintained by whoever remembered, and remembering is not a mechanism.
 * Prose about a route that 404s is worse than no prose: a client is written against it.
 *
 * The routes come out of the LIVE router the daemon builds, exactly the way
 * test/app-surface.test.ts derives them (express@5 keeps no copy of a mount path string,
 * only the matcher, so a prefix is proven by matching rather than read). That file is the
 * original of this enumeration; if the two ever need to disagree, the app is wrong.
 *
 * Both directions are asserted, and both name names. "The docs are out of date" is not
 * something anyone can act on at 2am; "POST /worktrees/install-deps is mounted and not
 * documented" is a one-line fix.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { muxStub } from './helpers.ts';
import type { Config } from '../server/types.ts';

const TOKEN = 'a'.repeat(64);
const DOC = path.join(import.meta.dirname, '..', 'docs', 'api.md');

// ---------------------------------------------------------------------------
// what the app mounts
// ---------------------------------------------------------------------------

/**
 * The real app, with real collaborators, pointed at a throwaway state directory.
 *
 * Nothing here is driven — the router is only asked what it holds — but it is still the
 * real buildApp() rather than a list, because a list is the thing that drifted.
 */
function buildTestApp() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-doc-drift-'));
  const uiRoot = path.join(stateDir, 'ui');
  fs.mkdirSync(path.join(uiRoot, 'client', 'build'), { recursive: true });
  fs.writeFileSync(path.join(uiRoot, 'client', 'build', 'index.html'), '<!doctype html>');

  const cfg: Config = {
    ...configMod.defaults(),
    baseDirs: [],
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
    cleanup: () => {
      (app.locals.transcriptIndex as { close(): void }).close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

interface Layer {
  name: string;
  matchers: Array<(p: string) => unknown>;
  /** `path` is an ARRAY when the route was registered for several — `app.get(['/', '/index.html'])`. */
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle: { stack?: Layer[] };
}

const pathsOf = (route: NonNullable<Layer['route']>): string[] =>
  Array.isArray(route.path) ? route.path : [route.path];

const stackOf = (app: express.Express): Layer[] =>
  (app as unknown as { router: { stack: Layer[] } }).router.stack;

const matches = (l: Layer, p: string): boolean => l.matchers.some((m) => !!m(p));

/** `"GET /sessions/:id/ci"` — one entry per verb, the way both sides are compared. */
function endpointsOf(router: Layer, prefix = ''): string[] {
  const out: string[] = [];
  for (const l of router.handle.stack || []) {
    if (!l.route) continue;
    for (const [method, on] of Object.entries(l.route.methods)) {
      if (!on) continue;
      for (const p of pathsOf(l.route)) out.push(`${method.toUpperCase()} ${prefix}${p}`);
    }
  }
  return out;
}

/**
 * Every route a client can call, prefix-stripped the way the doc writes them.
 *
 * The /api router (mounted twice — the two prefixes are one router, which is what makes
 * them identical) plus the routes mounted outside it. The document surface is excluded
 * below rather than here, so the exclusion has to be justified in one place.
 */
function mountedRoutes(app: express.Express): string[] {
  const layers = stackOf(app);
  const api = layers.find((l) => !l.route && !!l.handle.stack && matches(l, '/api'));
  assert.ok(api, 'the API router is mounted');
  const outside = layers
    .filter((l): l is Layer & { route: NonNullable<Layer['route']> } => !!l.route)
    .flatMap((l) =>
      Object.entries(l.route.methods)
        .filter(([, on]) => on)
        .flatMap(([m]) => pathsOf(l.route).map((p) => `${m.toUpperCase()} ${p}`)),
    );
  return [...endpointsOf(api), ...outside];
}

/*
 * The HTML surface, which docs/api.md is deliberately not about: it documents a JSON
 * contract for SwiftBar, Alfred, the CLI and the web UI, and these three are the browser
 * loading the app — `/` and `/index.html` are the injected document, `/{*splat}` is the
 * SPA fallback that turns a deep link into that same document. They are described in
 * prose under *Authentication* (the document is token-gated, the assets are not), which
 * is the right level for them. Everything else must be in the tables.
 */
const NOT_JSON_API = new Set(['GET /', 'GET /index.html', 'GET /{*splat}']);

/*
 * `ws://…/ws/term` is documented and has no express route by construction: the upgrade is
 * handled on the http server (server/server.ts), not the app, because the Host/Origin/token
 * checks have to run before the socket is accepted. Documented, real, unmountable.
 */
const NOT_EXPRESS = new Set(['WS /ws/term']);

// ---------------------------------------------------------------------------
// what the doc describes
// ---------------------------------------------------------------------------

const VERBS = 'GET|POST|PUT|PATCH|DELETE|WS';

/**
 * Every `` `VERB /path` `` in docs/api.md.
 *
 * Method-qualified on purpose. The doc refers to routes bare (“see `/servers/start`”) all
 * over the prose, and treating those as declarations would let a route be "documented" by
 * a passing mention. A route is documented when the doc states how to call it.
 */
function documentedRoutes(md: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = md.split('\n');
  let fenced = false;
  lines.forEach((line, i) => {
    // Code blocks are request/response examples, not the route tables. A sample that
    // happens to show `POST /sessions` should not be able to satisfy this test.
    if (line.startsWith('```')) fenced = !fenced;
    if (fenced) return;
    for (const m of line.matchAll(new RegExp('`(' + VERBS + ') +(\\S+?)`', 'g'))) {
      const verb = m[1];
      // `ws://…/ws/term` and the prefixed spellings the intro uses to explain the aliasing.
      const p = m[2].replace(/^ws:\/\/[^/]*/, '').replace(/^\/api(\/v1)?(?=\/)/, '');
      // Query strings are documented on the same line as the path they belong to.
      const bare = p.split('?')[0];
      if (!bare.startsWith('/')) continue;
      out.set(`${verb} ${bare}`, i + 1);
    }
  });
  return out;
}

/**
 * Param NAMES are not part of the contract — `:id` and `:sessionId` are the same route.
 * Compared on shape, reported with whichever spelling the side being reported uses.
 */
const shape = (r: string): string => r.replace(/:[^/]+/g, ':*');

const bullet = (rs: string[]): string => rs.map((r) => `\n  · ${r}`).join('');

// ---------------------------------------------------------------------------

test('every route the app mounts is documented in docs/api.md', () => {
  const { app, cleanup } = buildTestApp();
  try {
    const md = fs.readFileSync(DOC, 'utf8');
    const documented = new Set([...documentedRoutes(md).keys()].map(shape));
    const missing = mountedRoutes(app)
      .filter((r) => !NOT_JSON_API.has(r))
      .filter((r) => !documented.has(shape(r)))
      .sort();
    assert.deepEqual(
      missing,
      [],
      `${missing.length} route(s) the daemon mounts are absent from docs/api.md — a client cannot ` +
        `discover them, and the next person to touch them has no statement of what they promise:${bullet(missing)}`,
    );
  } finally {
    cleanup();
  }
});

test('every route docs/api.md describes still exists', () => {
  const { app, cleanup } = buildTestApp();
  try {
    const md = fs.readFileSync(DOC, 'utf8');
    const mounted = new Set(mountedRoutes(app).map(shape));
    const gone = [...documentedRoutes(md)]
      .filter(([r]) => !NOT_EXPRESS.has(r))
      .filter(([r]) => !mounted.has(shape(r)))
      .map(([r, line]) => `${r}  (docs/api.md:${line})`)
      .sort();
    assert.deepEqual(
      gone,
      [],
      `${gone.length} route(s) documented in docs/api.md are not mounted by the daemon. Documented ` +
        `routes that 404 are worse than undocumented ones — someone writes a client against them:${bullet(gone)}`,
    );
  } finally {
    cleanup();
  }
});
