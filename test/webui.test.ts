// Serving the frontend: which UI owns `/`, that every document goes through the token
// injector (including the SPA fallback a deep link lands on), that a missing build is a
// clear boot error rather than a blank page, and that the fallback cannot swallow the
// API routes SwiftBar, Alfred and the CLI depend on.
//
// Exercised through a real express app on an ephemeral port against fixture trees, so
// nothing here depends on client/build having been built.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import * as webui from '../server/webui.ts';

const TOKEN = 'a'.repeat(64);

// A repo-root-shaped fixture: client/build with an index.html.
function fixture({ client }: { client?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-webui-'));
  if (client !== undefined) {
    fs.mkdirSync(path.join(root, 'client', 'build', '_app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'client', 'build', 'index.html'), client);
    fs.writeFileSync(path.join(root, 'client', 'build', '_app', 'app.js'), 'export const x = 1;\n');
  }
  return root;
}

const SHELL = `<!doctype html><html><head><script>window.WTS_TOKEN = "${webui.PLACEHOLDER}";</script></head><body>app</body></html>`;

// Serve `app` for the duration of fn, handing it a (path, init) => Response fetcher.
type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
async function serving<T>(app: express.Express, fn: (get: Fetcher) => Promise<T>): Promise<T> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`;
  try {
    /*
     * Every request carries the token, because the document now demands one.
     *
     * These tests are about WHICH ui owns `/` and what gets substituted into the
     * shell — not about the gate, which test/webui-token.test.ts covers on its own.
     * Before the gate existed an unauthenticated GET returned the shell, so the
     * absence of a header here was invisible; afterwards it silently turned three
     * of these into assertions about the 401 page. A default header keeps each test
     * asking its own question. Pass an explicit `headers` to override it.
     */
    return await fn((p, init = {}) =>
      fetch(base + p, { ...init, headers: { 'x-wts-token': TOKEN, ...(init.headers || {}) } }),
    );
  } finally {
    server.close();
  }
}

// The daemon's own wiring order: static mount, then the API, then the SPA fallback.
function studio(root: string) {
  const ui = webui.resolve(root);
  const app = express();
  webui.mount(app, { ui, token: TOKEN });
  const api = express.Router();
  app.use('/api', api);
  app.use('/api/v1', api);
  api.get('/state', (_req, res) => res.json({ sessions: [] }));
  webui.mountFallback(app, { ui, token: TOKEN });
  return { app, ui };
}

// ---------------------------------------------------------------- resolve ----

test('resolve() serves the SvelteKit build', () => {
  const root = fixture({ client: SHELL });
  const ui = webui.resolve(root);
  assert.equal(ui.index, path.join(root, 'client', 'build', 'index.html'));
  assert.equal(ui.root, path.join(root, 'client', 'build'));
});

test('resolve() refuses to boot when the client has not been built, and says how', () => {
  const root = fixture(); // nothing laid down
  assert.throws(
    () => webui.resolve(root),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /has not been built/);
      assert.match(e.message, /npm run build/);
      return true;
    },
  );
});

// ------------------------------------------------------------------ mount ----

test('/ serves the shell with the token substituted, uncached', async () => {
  const { app } = studio(fixture({ client: SHELL }));
  await serving(app, async (get) => {
    for (const p of ['/', '/index.html']) {
      const r = await get(p);
      const html = await r.text();
      assert.equal(r.status, 200, p);
      assert.match(String(r.headers.get('content-type')), /text\/html/, p);
      assert.equal(r.headers.get('cache-control'), 'no-store', p);
      assert.ok(html.includes(`window.WTS_TOKEN = "${TOKEN}"`), p);
      assert.ok(!html.includes(webui.PLACEHOLDER), `${p}: no un-substituted placeholder`);
    }
  });
});

test('the static mount serves assets but never the un-injected index.html', async () => {
  const root = fixture({ client: SHELL });
  const { app } = studio(root);
  await serving(app, async (get) => {
    const asset = await get('/_app/app.js');
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /export const x/);
    // index:false — the only way to the document is through the injecting handler.
    const raw = fs.readFileSync(path.join(root, 'client', 'build', 'index.html'), 'utf8');
    assert.ok(raw.includes(webui.PLACEHOLDER), 'the file on disk keeps the placeholder');
    assert.ok(!(await (await get('/index.html')).text()).includes(webui.PLACEHOLDER));
  });
});

test('every occurrence of the placeholder is substituted, not just the first', async () => {
  // A second mention ahead of the real one (a comment is enough) would otherwise ship
  // window.WTS_TOKEN as the literal placeholder and 401 every API call.
  const doubled = `<!doctype html><!-- ${webui.PLACEHOLDER} --><script>window.WTS_TOKEN = "${webui.PLACEHOLDER}";</script>`;
  const { app } = studio(fixture({ client: doubled }));
  await serving(app, async (get) => {
    const html = await (await get('/')).text();
    assert.ok(!html.includes(webui.PLACEHOLDER));
    assert.equal(html.split(TOKEN).length - 1, 2);
  });
});

// --------------------------------------------------------------- fallback ----

test('a deep link to a client route serves the injected shell, not a 404', async () => {
  const { app } = studio(fixture({ client: SHELL }));
  await serving(app, async (get) => {
    for (const p of ['/review', '/search', '/usage', '/review?session=abc']) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('cache-control'), 'no-store', p);
      const html = await r.text();
      assert.ok(html.includes(`window.WTS_TOKEN = "${TOKEN}"`), `${p}: token injected`);
      assert.ok(!html.includes(webui.PLACEHOLDER), `${p}: no placeholder`);
    }
  });
});

test('the fallback shadows nothing: API routes still answer, unknown ones still 404', async () => {
  const { app } = studio(fixture({ client: SHELL }));
  await serving(app, async (get) => {
    for (const p of ['/api/state', '/api/v1/state']) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.deepEqual(await r.json(), { sessions: [] }, p);
    }
    // An unknown API path must stay a 404 for SwiftBar/Alfred/the CLI — never 200 HTML.
    for (const p of ['/api/nope', '/api/v1/nope', '/api', '/ws/term']) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
      assert.ok(!(await r.text()).includes(TOKEN), `${p}: no token handed to a non-document`);
    }
  });
});

// ----------------------------------------------------------- the real tree ----

test('app.html carries the placeholder exactly once', () => {
  // adapter-static copies app.html to build/index.html verbatim, so this file is where
  // the "exactly once" invariant actually lives. It is asserted here rather than on the
  // build because the build is generated and not in git.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'client', 'src', 'app.html'), 'utf8');
  assert.equal(src.split(webui.PLACEHOLDER).length - 1, 1);
});

test('the built client, when present, is servable and holds no token', () => {
  const index = path.join(import.meta.dirname, '..', 'client', 'build', 'index.html');
  if (!fs.existsSync(index)) return; // not built in this checkout — bin/build-client.ts makes it
  const html = fs.readFileSync(index, 'utf8');
  assert.equal(html.split(webui.PLACEHOLDER).length - 1, 1, 'exactly one placeholder');
  assert.ok(!/WTS_TOKEN = "[0-9a-f]{32,}"/.test(html), 'no real token baked into the build');
});
