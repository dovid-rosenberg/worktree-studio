import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawn, type ChildProcess } from 'child_process';

/*
 * A real daemon, over real HTTP.
 *
 * Everything else in this suite exercises modules directly; this boots
 * `node server/server.ts` as a process and talks to it the way a browser does. It is
 * the layer that would have caught the two broken auth layers and the missing-build
 * boot error — failures that live in the wiring between parts that each test fine.
 *
 * Deliberately narrow and hermetic: its own config, state dir, UI root and port, so it
 * touches nothing of the user's and cannot collide with a daemon they are running. It
 * asserts the contract a client depends on to boot at all — the token is injected into
 * the document, /api refuses without it, and the SSE stream opens and delivers a first
 * frame — not the behaviour of any one route.
 */

const TIMEOUT = 20_000;

interface Daemon {
  base: string;
  token: string;
  stop: () => void;
}

/**
 * A port nothing is listening on.
 *
 * `web.port: 0` would be the obvious way to say "you pick", but config.ts resolves the
 * port with `||`, and 0 is falsy — so it silently becomes the default 7788 and the
 * daemon refuses to boot against whatever is already there. Asking the OS for a free
 * port and handing over the number avoids relying on that.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Boot a daemon on a free port with a throwaway everything. */
async function boot(): Promise<Daemon> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-smoke-'));
  const stateDir = path.join(dir, 'state');
  const configFile = path.join(dir, 'config.json');
  const port = await freePort();
  fs.writeFileSync(configFile, JSON.stringify({ baseDirs: [], web: { host: '127.0.0.1', port } }));

  // A stub UI: this test is about the daemon, and a missing client/build is a fatal
  // boot error that would fail it for an unrelated reason.
  fs.mkdirSync(path.join(dir, 'client', 'build'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'client', 'build', 'index.html'),
    '<!doctype html><script>window.WTS_TOKEN = "__WTS_TOKEN__";</script><body>ok</body>',
  );

  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(import.meta.dirname, '..', 'server', 'server.ts')],
    {
      env: {
        ...process.env,
        WT_STUDIO_CONFIG: configFile,
        WT_STUDIO_STATE: stateDir,
        WT_STUDIO_UI_ROOT: dir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let out = '';
  child.stdout?.on('data', (d) => { out += d; });
  child.stderr?.on('data', (d) => { out += d; });

  // The daemon prints its URL when it is listening; that line is the ready signal.
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon never reported a URL:\n${out}`)), TIMEOUT);
    const poll = setInterval(() => {
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearInterval(poll); clearTimeout(timer); resolve(m[0]); }
      if (child.exitCode !== null) {
        clearInterval(poll); clearTimeout(timer);
        reject(new Error(`daemon exited ${child.exitCode}:\n${out}`));
      }
    }, 100);
  });

  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  return { base: url, token, stop: () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } } };
}

test('a real daemon serves the document with the token substituted', { timeout: TIMEOUT }, async () => {
  const d = await boot();
  try {
    const res = await fetch(`${d.base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    // The placeholder is how the token reaches the tab; shipping it unsubstituted 401s
    // every API call from a page that otherwise looks fine.
    assert.ok(!html.includes('__WTS_TOKEN__'), 'placeholder must not survive');
    assert.ok(html.includes(d.token), 'the real token must be in the document');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally { d.stop(); }
});

test('a real daemon refuses /api without the token and answers with it', { timeout: TIMEOUT }, async () => {
  const d = await boot();
  try {
    const bare = await fetch(`${d.base}/api/state`);
    assert.equal(bare.status, 401, 'no token → refused');

    const ok = await fetch(`${d.base}/api/state`, { headers: { 'x-wts-token': d.token } });
    assert.equal(ok.status, 200);
    // `res.json()` is `unknown` under strict, which is right — this is a wire payload,
    // and asserting its shape is the point of the test.
    const state = await ok.json() as { sessions?: unknown; repos?: unknown; mux?: unknown };
    // The shape every client boots against.
    assert.ok(Array.isArray(state.sessions), 'sessions[]');
    assert.ok(Array.isArray(state.repos), 'repos[]');
    assert.equal(typeof state.mux, 'string');
  } finally { d.stop(); }
});

test('an unknown /api path stays a 404 rather than becoming the SPA document', { timeout: TIMEOUT }, async () => {
  // SwiftBar, Alfred and the CLI all depend on this: a 200 text/html for a mistyped
  // endpoint is far worse to debug than a 404.
  const d = await boot();
  try {
    const res = await fetch(`${d.base}/api/nope`, { headers: { 'x-wts-token': d.token } });
    assert.equal(res.status, 404);
    // Express's own 404 page is HTML, so the content type says nothing. What matters is
    // that this is NOT the app shell: the SPA fallback must not swallow /api.
    assert.ok(!(await res.text()).includes(d.token), 'must not be the injected document');
  } finally { d.stop(); }
});

test('a deep link falls back to the document, not a 404', { timeout: TIMEOUT }, async () => {
  const d = await boot();
  try {
    const res = await fetch(`${d.base}/anything/deep`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes(d.token), 'the fallback must inject too');
  } finally { d.stop(); }
});

test('the SSE stream opens and delivers a first frame', { timeout: TIMEOUT }, async () => {
  // EventSource cannot set headers, so the token rides in the query string — the one
  // transport where that is true, and a place auth has broken before.
  const d = await boot();
  const ac = new AbortController();
  try {
    const res = await fetch(`${d.base}/api/events?token=${encodeURIComponent(d.token)}`, {
      headers: { accept: 'text/event-stream' },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /event-stream/);

    const reader = res.body!.getReader();
    const deadline = Date.now() + 8000;
    let buf = '';
    while (Date.now() < deadline && !/^event: /m.test(buf)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
    }
    // One of each half is written before a client joins the fan-out, so a first
    // connection starts from a complete snapshot rather than waiting for a change.
    assert.match(buf, /^event: (topology|session-state|ci)$/m, `no named event arrived:\n${buf.slice(0, 300)}`);
  } finally { ac.abort(); d.stop(); }
});
