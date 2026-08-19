// The document is a credential, and this is what proves it behaves like one.
//
// `GET /` is the only response that contains the boot token in its body. The Host/Origin
// gate in front of the app cannot protect it: that gate stops *browsers* being used as a
// proxy, and says nothing about a local process that simply asks. Before the check these
// tests cover, `curl 127.0.0.1:7788/` printed the live token to anything running as the
// user — an API that 401s is no boundary at all once the token is free.
//
// So: no token in, no token out. A request that already proves it has the token (query
// on the first navigation, cookie thereafter, header for non-browsers) still gets the
// injected shell, because a UI that cannot boot is not a fix.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import * as webui from '../server/webui.ts';

const TOKEN = 'a'.repeat(64);
const WRONG = 'b'.repeat(64);

// A repo-root-shaped fixture: client/build with an index.html carrying the placeholder.
const SHELL = `<!doctype html><html><head><script>window.WTS_TOKEN = "${webui.PLACEHOLDER}";</script></head><body>app</body></html>`;

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-webui-token-'));
  fs.mkdirSync(path.join(root, 'client', 'build', '_app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client', 'build', 'index.html'), SHELL);
  fs.writeFileSync(path.join(root, 'client', 'build', '_app', 'app.js'), 'export const x = 1;\n');
  return root;
}

// The daemon's own wiring order: document + static mount, the API, then the SPA fallback.
function studio() {
  const ui = webui.resolve(fixture());
  const app = express();
  webui.mount(app, { ui, token: TOKEN });
  const api = express.Router();
  app.use('/api', api);
  app.use('/api/v1', api);
  api.get('/state', (_req, res) => res.json({ sessions: [] }));
  webui.mountFallback(app, { ui, token: TOKEN });
  return app;
}

// redirect:'manual' throughout: the 303 that turns `?token=` into a cookie is the thing
// under test, and a following fetch would hide both the Location and the Set-Cookie.
type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
async function serving<T>(fn: (get: Fetcher) => Promise<T>): Promise<T> {
  const server = studio().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`;
  try {
    return await fn((p, init = {}) => fetch(base + p, { redirect: 'manual', ...init }));
  } finally {
    server.close();
  }
}

test('an unauthenticated document request is refused and hands out no token', async () => {
  await serving(async (get) => {
    // Every path that goes through the injector: the two mount() claims and the SPA
    // fallback a deep link lands on.
    for (const p of ['/', '/index.html', '/review', '/review?session=abc']) {
      const r = await get(p);
      const body = await r.text();
      assert.equal(r.status, 401, `${p} is refused without a token`);
      assert.ok(!body.includes(TOKEN), `${p}: the refusal body contains no token`);
      assert.ok(!body.includes('WTS_TOKEN'), `${p}: not even the injected global`);
      assert.equal(r.headers.get('cache-control'), 'no-store', `${p} is never cached`);
      // The refusal has to be actionable, or the next move is to turn the check off.
      assert.match(body, /token/i, `${p}: says what is missing`);
    }
  });
});

test('a wrong token is refused exactly like no token at all', async () => {
  await serving(async (get) => {
    for (const [what, init] of [
      ['query', { path: `/?token=${WRONG}` }],
      ['header', { path: '/', headers: { 'x-wts-token': WRONG } }],
      ['cookie', { path: '/', headers: { cookie: `wts_token=${WRONG}` } }],
      ['truncated token', { path: `/?token=${TOKEN.slice(0, 20)}` }],
    ] as Array<[string, { path: string; headers?: Record<string, string> }]>) {
      const r = await get(init.path, { headers: init.headers });
      assert.equal(r.status, 401, `a wrong token via ${what} is refused`);
      assert.ok(!(await r.text()).includes(TOKEN), `${what}: no token in the refusal`);
    }
  });
});

test('the token in the header or the cookie gets the injected shell', async () => {
  await serving(async (get) => {
    for (const [what, headers] of [
      ['header', { 'x-wts-token': TOKEN }],
      ['cookie', { cookie: `wts_token=${TOKEN}` }],
      // Real browsers send more than ours; the parse must not depend on position.
      ['cookie among others', { cookie: `theme=dark; wts_token=${TOKEN}; sidebar=1` }],
    ] as Array<[string, Record<string, string>]>) {
      for (const p of ['/', '/index.html', '/review']) {
        const r = await get(p, { headers });
        assert.equal(r.status, 200, `${p} via ${what}`);
        const html = await r.text();
        assert.ok(html.includes(`window.WTS_TOKEN = "${TOKEN}"`), `${p} via ${what}: token injected`);
        assert.ok(!html.includes(webui.PLACEHOLDER), `${p} via ${what}: no un-substituted placeholder`);
        assert.equal(r.headers.get('cache-control'), 'no-store', `${p} via ${what}: uncached`);
      }
    }
  });
});

test('?token= on the first navigation becomes a cookie and is redirected out of the URL', async () => {
  await serving(async (get) => {
    const r = await get(`/review?session=abc&token=${TOKEN}`);
    assert.equal(r.status, 303, 'the token URL is not answered with the document');
    // A 200 here would leave the token in history, in the referrer of the first outbound
    // link, and on screen in the address bar.
    assert.equal(r.headers.get('location'), '/review?session=abc', 'redirected to the clean URL');
    assert.ok(!String(r.headers.get('location')).includes(TOKEN), 'and the token is gone from it');
    const setCookie = String(r.headers.get('set-cookie') || '');
    assert.ok(setCookie.includes(`wts_token=${TOKEN}`), 'the token is handed over as a cookie');
    assert.match(setCookie, /SameSite=Strict/i, 'Strict: nothing legitimate navigates in from elsewhere');
    assert.match(setCookie, /Path=\//i, 'the whole app, including deep links');
    assert.doesNotMatch(setCookie, /HttpOnly/i, 'the SPA reads it, so HttpOnly would only break it');
    assert.equal(r.headers.get('cache-control'), 'no-store', 'a Set-Cookie response is never cached');

    // …and the cookie it just handed over is what the redirect target accepts.
    const cookie = setCookie.split(';')[0];
    const doc = await get('/review?session=abc', { headers: { cookie } });
    assert.equal(doc.status, 200, 'the redirect lands on the real document');
    assert.ok((await doc.text()).includes(`window.WTS_TOKEN = "${TOKEN}"`));
  });
});

test('the document cannot be framed', async () => {
  // The tab holds the token, so a page that can frame it can drive the studio by
  // clickjacking — and the frame carries an honest Host, so the Host gate lets it in.
  await serving(async (get) => {
    for (const [what, init] of [
      ['the shell', { path: '/', headers: { 'x-wts-token': TOKEN } }],
      ['the refusal', { path: '/', headers: {} }],
    ] as Array<[string, { path: string; headers: Record<string, string> }]>) {
      const r = await get(init.path, { headers: init.headers });
      assert.equal(r.headers.get('x-frame-options'), 'DENY', `${what}: X-Frame-Options`);
      assert.equal(
        r.headers.get('content-security-policy'),
        "frame-ancestors 'none'",
        `${what}: frame-ancestors`,
      );
    }
  });
});

test('gating the document leaves the API and the asset mount alone', async () => {
  // The gate is on the injector only. Breaking either of these would be a fix that
  // takes the UI down with it: the assets are what the shell loads, and /api carries
  // its own token check (security.ts) that must stay the only one there.
  await serving(async (get) => {
    const asset = await get('/_app/app.js');
    assert.equal(asset.status, 200, 'assets do not need the token — they hold no secret');
    assert.match(await asset.text(), /export const x/);
    for (const p of ['/api/state', '/api/v1/state']) {
      const r = await get(p);
      assert.equal(r.status, 200, `${p} is untouched by the document gate`);
    }
    for (const p of ['/api/nope', '/ws/term']) {
      const r = await get(p);
      assert.equal(r.status, 404, `${p} stays a 404 rather than becoming a challenge page`);
      assert.ok(!(await r.text()).includes(TOKEN), `${p}: no token`);
    }
  });
});
