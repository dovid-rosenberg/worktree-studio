// The three controls in front of the server, exercised against a real HTTP server
// and a real WebSocket upgrade on an ephemeral port — the checks live in the
// transport layer, so testing them any further from it would prove nothing.
//
// What each block is asserting, in the terms of the attack it stops:
//   Origin  — a page on another site driving the studio through the user's browser.
//             WebSockets are exempt from CORS, so this is the *only* thing between
//             an open tab and a read/write PTY.
//   Host    — DNS rebinding, where that page becomes same-origin and CORS stops
//             applying. The Host header still names the attacker's domain.
//   token   — everything that is not a browser at all, where Origin is absent and
//             therefore cannot be the check.
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { makeId, shortId, writeJson } from '../server/util.ts';
import { muxNameFor, SessionManager } from '../server/sessions.ts';
import { loadToken, createGuard, splitHostPort } from '../server/security.ts';
import * as status from '../server/status.ts';
import type { AddressInfo } from 'net';
import { muxStub, present, session } from './helpers.ts';

const TOKEN = 'a'.repeat(64);

// A miniature of server.ts's wiring: same middleware order, same upgrade handler,
// with the pty replaced by an echo of what the socket was allowed to reach.
function harness({ port }: { port?: number } = {}) {
  const cfg = { web: { host: '127.0.0.1', port: port || 0 } };
  const guard = createGuard({ cfg, token: TOKEN });
  const app = express();
  app.use(guard.browser);
  app.use(express.json());
  app.get('/', (_req, res) => res.type('html').send(`<script>window.WTS_TOKEN = "${TOKEN}";</script>`));
  app.use('/api', guard.authed);
  const api = express.Router();
  app.use('/api', api);
  app.use('/api/v1', api);
  api.get('/state', (_req, res) => res.json({ ok: true, sessions: [] }));

  // Same shape as server.ts's hook receiver, including the grandfather clause.
  const sessions = new Map([
    ['s_new', { id: 's_new', hookAuth: true }], // settings file written with a token
    ['s_legacy', { id: 's_legacy' }], // launched before the token existed
  ]);
  const hooks: string[] = [];
  app.post('/hook/:event', (req, res) => {
    const known = sessions.get(String(req.query.wts));
    const deny = guard.denyToken(req);
    if (deny && !(known && known.hookAuth !== true))
      return res.status(deny.status).json({ error: deny.error });
    if (known) hooks.push(`${known.id}:${req.params.event}`);
    return res.json({ ok: true });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const attached: Array<string | null> = []; // session ids that got as far as "spawn a pty"
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '', 'http://localhost');
    if (url.pathname !== '/ws/term') {
      socket.destroy();
      return;
    }
    const deny = guard.denyBrowser(req) || guard.denyToken(req, url.searchParams.get('token'));
    if (deny) {
      socket.write(
        `HTTP/1.1 ${deny.status} ${deny.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    const id = new URL(req.url || '', 'http://localhost').searchParams.get('session');
    attached.push(id); // stands in for pty.spawn — reaching here IS the vulnerability
    ws.send(`attached:${id}`);
  });
  return { app, server, cfg, guard, attached, hooks };
}

// Run `fn` against a listening harness, with the guard's expected port synced to the
// ephemeral one the OS handed out (mirrors a real run, where they always agree).
type Harness = ReturnType<typeof harness> & {
  port: number;
  origin: string;
  get: (path: string, init?: RequestInit) => Promise<Response>;
};
async function serving<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  const h = harness();
  h.server.listen(0, '127.0.0.1');
  await new Promise((r) => h.server.once('listening', r));
  const port = (present(h.server.address()) as AddressInfo).port;
  h.cfg.web.port = port;
  const origin = `http://127.0.0.1:${port}`;
  const get = (p: string, init: RequestInit = {}) =>
    fetch(origin + p, { ...init, headers: { host: `127.0.0.1:${port}`, ...(init.headers || {}) } });
  try {
    return await fn({ ...h, port, origin, get });
  } finally {
    h.server.close();
  }
}

// undici's fetch silently drops a caller-set Host (it is a forbidden header name), so
// the rebinding cases are driven with a raw client — which is what the attacker is
// doing anyway. setHost:false means we control the header completely, including
// omitting it.
interface RawResult {
  status?: number;
  body: unknown;
}
function raw(
  port: number,
  { path: p = '/api/state', headers = {} }: { path?: string; headers?: Record<string, string> } = {},
): Promise<RawResult> {
  return new Promise<RawResult>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'GET', headers, setHost: false },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch {
            parsed = body;
          } // node's own 400s are plain text
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// Open a ws to the harness and resolve with what happened, never throwing: a refused
// handshake and an accepted one both have to be observable.
interface ProbeOpts {
  origin?: string;
  host?: string;
  token?: string;
  session?: string;
}
/** Whether the socket opened, what it said, and — when refused — the handshake status. */
interface ProbeResult {
  open: boolean;
  said?: string | null;
  status?: number | null;
}
function wsProbe(
  port: number,
  { origin, host, token, session = 's_1' }: ProbeOpts = {},
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const headers: Record<string, string> = {};
    if (origin) headers.Origin = origin;
    if (host) headers.Host = host;
    const q = `?session=${encodeURIComponent(session)}${token ? `&token=${token}` : ''}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term${q}`, { headers });
    let settled = false;
    const done = (v: ProbeResult) => {
      if (!settled) {
        settled = true;
        try {
          ws.close();
        } catch {
          /* */
        }
        resolve(v);
      }
    };
    ws.on('message', (m) => done({ open: true, said: m.toString('utf8') }));
    ws.on('open', () => setTimeout(() => done({ open: true, said: null }), 200));
    ws.on('unexpected-response', (_req, res) => done({ open: false, status: res.statusCode }));
    ws.on('error', () => done({ open: false, status: null }));
  });
}

/* ---------------- the WebSocket upgrade ---------------- */

test('a cross-origin WS upgrade is refused before any pty is spawned', async () => {
  await serving(async ({ port, attached }) => {
    for (const origin of ['https://evil.com', 'http://evil.com', 'http://localhost:3000', 'null']) {
      const r = await wsProbe(port, { origin, token: TOKEN });
      assert.equal(r.open, false, `${origin} must not reach an open socket`);
      assert.equal(r.status, 403, `${origin} is refused with 403`);
    }
    assert.deepEqual(attached, [], 'no upgrade got as far as attaching a terminal');
  });
});

test('a WS upgrade with a rebinding-style Host is refused', async () => {
  await serving(async ({ port, origin, attached }) => {
    const r = await wsProbe(port, { host: 'evil.com', origin, token: TOKEN });
    assert.equal(r.open, false);
    assert.equal(r.status, 403);
    assert.deepEqual(attached, []);
  });
});

test('a WS upgrade with a missing or wrong token is refused', async () => {
  await serving(async ({ port, origin, attached }) => {
    assert.equal((await wsProbe(port, { origin })).status, 401, 'no token');
    assert.equal((await wsProbe(port, { origin, token: 'b'.repeat(64) })).status, 401, 'wrong token');
    assert.equal((await wsProbe(port, { origin, token: TOKEN.slice(0, 10) })).status, 401, 'truncated token');
    assert.deepEqual(attached, []);
  });
});

test('a same-origin WS upgrade with the token attaches the terminal', async () => {
  await serving(async ({ port, origin, attached }) => {
    const r = await wsProbe(port, { origin, token: TOKEN, session: 's_live' });
    assert.equal(r.open, true, 'the real UI still connects');
    assert.equal(r.said, 'attached:s_live');
    assert.deepEqual(attached, ['s_live'], 'and only this one reached the pty');
  });
});

/* ---------------- the JSON API ---------------- */

test('an API call with no token or the wrong token is refused', async () => {
  await serving(async ({ get }) => {
    const none = await get('/api/state');
    assert.equal(none.status, 401);
    assert.deepEqual(await none.json(), { error: 'missing or invalid token' });
    assert.equal((await get('/api/state', { headers: { 'x-wts-token': 'b'.repeat(64) } })).status, 401);
    assert.equal((await get('/api/state?token=nope')).status, 401);
    assert.equal((await get('/api/v1/state')).status, 401, 'the versioned prefix is not a way around it');
  });
});

test('the token is accepted as a header, a bearer, or a query param', async () => {
  await serving(async ({ get }) => {
    for (const init of [
      { headers: { 'x-wts-token': TOKEN } },
      { headers: { authorization: `Bearer ${TOKEN}` } },
      {},
    ]) {
      const p = init.headers ? '/api/state' : `/api/state?token=${TOKEN}`; // EventSource/WS can only do the query
      const r = await get(p, init);
      assert.equal(r.status, 200, `accepted via ${init.headers ? Object.keys(init.headers)[0] : 'query'}`);
      assert.deepEqual(await r.json(), { ok: true, sessions: [] });
    }
  });
});

test('a rebinding-style Host is refused even with a valid token', async () => {
  await serving(async ({ port }) => {
    for (const host of [
      'evil.com',
      `evil.com:${port}`,
      `127.0.0.1.nip.io:${port}`,
      `127.0.0.1:${port + 1}`,
    ]) {
      const r = await raw(port, { headers: { host, 'x-wts-token': TOKEN } });
      assert.equal(r.status, 403, `Host: '${host}' is refused`);
      assert.deepEqual(r.body, { error: 'forbidden host' });
    }
    // No Host header at all is refused too, rather than defaulting to "fine" — node's
    // own HTTP/1.1 parser gets there first with a 400, which is equally a refusal.
    const noHost = await raw(port, { headers: { 'x-wts-token': TOKEN } });
    assert.ok(
      noHost.status === 400 || noHost.status === 403,
      `a Host-less request is refused (got ${noHost.status})`,
    );
    // And the honest ones still pass.
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      assert.equal(
        (await raw(port, { headers: { host, 'x-wts-token': TOKEN } })).status,
        200,
        `Host: '${host}' is allowed`,
      );
    }
  });
});

test('the token-bearing index.html is unreachable through a rebound Host', async () => {
  // This is the interlock: injecting the token into the HTML is only safe because a
  // rebinding page never gets a body to read it out of.
  await serving(async ({ port }) => {
    const r = await raw(port, { path: '/', headers: { host: `evil.com:${port}` } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: 'forbidden host' });
  });
});

test('a cross-origin JSON request is refused even with a valid token', async () => {
  await serving(async ({ get }) => {
    for (const origin of ['https://evil.com', 'http://localhost:3000', 'null', 'file://']) {
      const r = await get('/api/state', { headers: { origin, 'x-wts-token': TOKEN } });
      assert.equal(r.status, 403, `Origin: ${origin} is refused`);
      assert.deepEqual(await r.json(), { error: 'forbidden origin' });
    }
  });
});

test('legitimate same-origin traffic works end to end', async () => {
  await serving(async ({ get, origin, port }) => {
    // 1. the browser loads the page and is handed the token
    const page = await get('/', { headers: { origin } });
    assert.equal(page.status, 200);
    const html = await page.text();
    const token = present(
      present(/window\.WTS_TOKEN = "([^"]+)"/.exec(html), 'the injected token')[1],
      'the token capture',
    );
    assert.equal(token, TOKEN);
    // 2. it calls the API with that token, same-origin, under both prefixes
    for (const p of ['/api/state', '/api/v1/state']) {
      const r = await get(p, { headers: { origin, 'x-wts-token': token } });
      assert.equal(r.status, 200, `${p} still works for the real UI`);
    }
    // 3. and opens the terminal socket with it
    const ws = await wsProbe(port, { origin, token, session: 's_e2e' });
    assert.equal(ws.said, 'attached:s_e2e');
  });
});

test('a non-browser client (no Origin at all) still works with the token', async () => {
  // SwiftBar, Alfred, the CLI and the hook script send no Origin — "absent" has to
  // stay allowed, which is exactly why the token cannot be optional.
  await serving(async ({ get }) => {
    assert.equal((await get('/api/state', { headers: { 'x-wts-token': TOKEN } })).status, 200);
  });
});

/* ---------------- the Claude Code hook receiver ---------------- */

test('the hook receiver takes the token, and grandfathers only pre-token sessions', async () => {
  await serving(async ({ origin, hooks }) => {
    const post = (q: string, headers: Record<string, string> = {}) =>
      fetch(`${origin}/hook/Stop?${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      });
    // The URL baked into a settings file carries the token in the query string —
    // the hook script gets a URL and nothing else.
    assert.equal((await post(`wts=s_new&token=${TOKEN}`)).status, 200);
    // A session whose settings file we have written *with* a token gets no exemption.
    assert.equal((await post('wts=s_new')).status, 401);
    // One launched before the token existed still reports: its claude read that file
    // at startup and will never re-read it, so refusing would mute it silently.
    assert.equal((await post('wts=s_legacy')).status, 200);
    // An id nobody knows gets nothing — the exemption is not a way in.
    assert.equal((await post('wts=s_guessed')).status, 401);
    assert.equal((await post('')).status, 401);
    assert.deepEqual(hooks, ['s_new:Stop', 's_legacy:Stop']);
  });
});

test('buildSettings bakes the token into every hook URL', () => {
  const withTok = status.buildSettings('s_1', 7788, 'tok-123');
  for (const ev of Object.keys(withTok.hooks)) {
    const cmd = withTok.hooks[ev][0].hooks[0].command;
    assert.match(cmd, /wts=s_1&token=tok-123/, `${ev} carries the token`);
  }
  // No token configured → the old, tokenless URL, so nothing breaks by surprise.
  assert.doesNotMatch(status.buildSettings('s_1', 7788).hooks.Stop[0].hooks[0].command, /token=/);
});

test('a session written through the manager records that its hooks are authed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-hookauth-'));
  const mgr = new SessionManager({ _stateDir: dir, web: { port: 7788 }, _token: 'tok-123' }, muxStub());
  const s = session({ id: 's_x' });
  mgr._writeHookSettings(s);
  assert.equal(s.hookAuth, true);
  const settingsFile = present(s.settingsFile, 'the generated settings file');
  assert.match(fs.readFileSync(settingsFile, 'utf8'), /token=tok-123/);
  assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600, 'the file holds a secret now');
});

/* ---------------- the pieces ---------------- */

test('loadToken writes a 0600 token once and reuses it across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-token-'));
  const first = loadToken(dir);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600);
  // Stable across restarts on purpose: live sessions have it baked into the hook
  // URLs of a settings file their claude process already read.
  assert.equal(loadToken(dir), first);
  // A truncated/emptied file is treated as absent rather than trusted.
  fs.writeFileSync(path.join(dir, 'token'), 'short\n');
  assert.notEqual(loadToken(dir), 'short');
  assert.match(loadToken(dir), /^[0-9a-f]{64}$/);
});

test('writeJson keeps its files to this user, and fixes a file that is already open', () => {
  // Everything writeJson writes is per-user state and some of it is secret: config.json
  // holds the Asana personal access token, sessions.json holds the session ids that are
  // the credential for /ws/term. Under the default umask they landed at 0644 — readable
  // by every account on the machine.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-writejson-'));
  const file = path.join(dir, 'nested', 'config.json');
  writeJson(file, { forge: { token: 'secret' } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'a new file is written 0600');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { forge: { token: 'secret' } });
  // The rename installs the temp file's inode, so a config.json already sitting at 0644
  // from an older build is corrected by the next save rather than staying exposed.
  fs.chmodSync(file, 0o644);
  writeJson(file, { forge: { token: 'secret2' } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'an existing 0644 file is tightened');
  // No temp file is left behind holding the same secret at whatever mode.
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-')),
    [],
    'the temp file is renamed away, not left next to it',
  );
});

test('splitHostPort refuses what it cannot parse rather than guessing', () => {
  assert.deepEqual(splitHostPort('127.0.0.1:7788'), { host: '127.0.0.1', port: '7788' });
  assert.deepEqual(splitHostPort('LocalHost'), { host: 'localhost', port: '' });
  assert.deepEqual(splitHostPort('[::1]:7788'), { host: '[::1]', port: '7788' });
  assert.equal(splitHostPort('::1:7788'), null, 'an unbracketed IPv6 literal is ambiguous');
  assert.equal(splitHostPort(''), null);
  assert.equal(splitHostPort(undefined), null);
});

test('session ids are unguessable UUIDs and old ids keep working', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 500; i++) ids.add(makeId('s_'));
  assert.equal(ids.size, 500, 'no collisions');
  for (const id of ids)
    assert.match(id, /^s_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Ids are only ever compared for equality and used as map keys — an id minted by
  // the old scheme is still a perfectly good key, which is what keeps the sessions
  // already in sessions.json working.
  const legacy = 's_5ii11';
  const m = new Map([[legacy, { id: legacy }]]);
  assert.equal(present(m.get(legacy)).id, legacy);
  // …and it still yields a usable tmux-name suffix.
  assert.equal(shortId('s_81dda83a-346f-4c51-b6e9-81a28e169b42'), '8e169b42');
  assert.ok(shortId(legacy).length > 0);
});

test('the mux name stays short and unique once ids are UUIDs', () => {
  const long = 'a-very-long-feature-name-that-eats-the-whole-budget';
  const names = new Set();
  for (let i = 0; i < 200; i++) {
    const name = muxNameFor(long, makeId('s_'));
    assert.ok(name.length <= 60);
    // The suffix must survive the truncation — otherwise every session of one
    // feature would collide on the same tmux session name.
    assert.match(name, /-[0-9a-f]{8}$/);
    names.add(name);
  }
  assert.equal(names.size, 200);
});
