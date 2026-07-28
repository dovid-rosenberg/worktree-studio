// Crash policy (server/crash.ts) + the thing it exists to prevent: a daemon whose
// listen() failed staying alive with no HTTP server.
//
// The unit half drives the classification through injected process hooks, so no
// real handler is armed and the test runner is never killed. The integration half
// boots the REAL server against an occupied port, in a throwaway config/state dir,
// and asserts it exits non-zero — that is the incident, reproduced.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import * as crash from '../server/crash.ts';
import { present } from './helpers.ts';
import type { AddressInfo } from 'net';
import { EventEmitter } from 'events';
import express from 'express';

// Arm install() against fakes and return what it did.
function armed() {
  const handlers = new Map<string, (e: unknown) => void>();
  const logs: string[] = [];
  const exits: number[] = [];
  crash.install({
    log: (...a: unknown[]) => logs.push(a.map((x) => (x instanceof Error ? `${errCode(x)} ${x.message}` : String(x))).join(' ')),
    exit: (c: number) => exits.push(c),
    on: (name: string, fn: (e: unknown) => void) => handlers.set(name, fn),
  });
  return { handlers, logs, exits };
}

// A Node-style error: the `code` is the only thing crash.ts classifies on. `code` is
// not on `Error`, which is exactly why crash.ts reads it defensively.
function err(code: string, message = 'boom'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
const errCode = (e: Error): string => String((e as { code?: unknown }).code ?? '');

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

test('a dead client connection is the only survivable exception class', () => {
  for (const code of crash.CONNECTION_ERROR_CODES) assert.equal(crash.isConnectionError(err(code)), true, code);
  for (const code of ['EADDRINUSE', 'EACCES', 'ENOENT', 'ENOSPC', 'ERR_INVALID_ARG_TYPE']) {
    assert.equal(crash.isConnectionError(err(code)), false, code);
  }
  assert.equal(crash.isConnectionError(new Error('no code at all')), false, 'a plain throw is a bug, not a lost socket');
  assert.equal(crash.isConnectionError(undefined), false);
  assert.equal(crash.isConnectionError('a string was thrown'), false);
});

test('an uncaught EADDRINUSE exits non-zero instead of being logged and survived', () => {
  const { handlers, exits } = armed();
  present(handlers.get('uncaughtException'), 'uncaughtException')(err('EADDRINUSE', 'listen EADDRINUSE'));
  assert.deepEqual(exits, [1], 'a failed bind must be fatal');
});

test('an uncaught programming error exits non-zero', () => {
  const { handlers, exits, logs } = armed();
  present(handlers.get('uncaughtException'), 'uncaughtException')(new TypeError('x is not a function'));
  assert.deepEqual(exits, [1]);
  assert.ok(logs.join('\n').includes('fatal uncaughtException'), logs.join('\n'));
});

test('an unhandled rejection is fatal too — it is the same failure reached through await', () => {
  const { handlers, exits } = armed();
  present(handlers.get('unhandledRejection'), 'unhandledRejection')(new Error('nobody caught me'));
  assert.deepEqual(exits, [1]);
});

test('a client that vanished mid-write is survived, not fatal', () => {
  const { handlers, exits, logs } = armed();
  present(handlers.get('uncaughtException'), 'uncaughtException')(err('EPIPE', 'write EPIPE'));
  present(handlers.get('unhandledRejection'), 'unhandledRejection')(err('ECONNRESET', 'read ECONNRESET'));
  assert.deepEqual(exits, [], 'one dead SSE/WebSocket socket must not take the daemon down');
  assert.equal(logs.length, 2);
  assert.ok(logs.every((l) => l.includes('continuing')), logs.join('\n'));
});

// ---------------------------------------------------------------------------
// guardListen
// ---------------------------------------------------------------------------

test('guardListen turns a bind failure into an explained non-zero exit', () => {
  const server = new EventEmitter();
  const logs: string[] = []; const exits: number[] = [];
  crash.guardListen(server, { host: '127.0.0.1', port: 4300 }, { log: (...a: unknown[]) => logs.push(String(a[0])), exit: (c: number) => exits.push(c) });
  server.emit('error', err('EADDRINUSE', 'listen EADDRINUSE 127.0.0.1:4300'));
  assert.deepEqual(exits, [1]);
  assert.ok(/port 4300 is already in use/.test(logs.join('\n')), logs.join('\n'));
});

test('listenErrorMessage names the remedy for each bind failure and ignores the rest', () => {
  assert.match(present(crash.listenErrorMessage(err('EADDRINUSE'), { host: '127.0.0.1', port: 4300 })), /already in use/);
  assert.match(present(crash.listenErrorMessage(err('EACCES'), { host: '127.0.0.1', port: 80 })), /web\.port/);
  assert.equal(crash.listenErrorMessage(err('EPIPE'), { port: 1 }), null);
  assert.equal(crash.listenErrorMessage(null, {}), null);
});

// ---------------------------------------------------------------------------
// routeErrors — the request-level half
// ---------------------------------------------------------------------------
//
// This is the whole point of the express@5 upgrade. Under express@4 a rejected
// handler escaped to the process, and the rule above makes that FATAL — so every
// handler had to be hand-wrapped in `A()` and one omission killed the daemon.
// express@5 forwards the rejection here instead. These tests are what stops the
// wrapper's removal from being a regression.

// Drive the middleware directly with fakes, the way armed() does for install().
function through(err: unknown, { headersSent = false } = {}) {
  const logs: string[] = [];
  const sent: { status: number | null; body: unknown; nexted: unknown } = { status: null, body: null, nexted: undefined };
  const res: crash.ErrorResponse = {
    headersSent,
    status(c: number) { sent.status = c; return { json(b: unknown) { sent.body = b; return undefined; } }; },
  };
  const req: crash.ErrorRequest = { method: 'GET', originalUrl: '/api/v1/state?token=deadbeef' };
  crash.routeErrors({ log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) })(
    err, req, res, (e?: unknown) => { sent.nexted = e; },
  );
  return { ...sent, logs };
}

test('an escaped throw is a 500 carrying the error message — the documented shape', () => {
  const r = through(new Error('git exploded'));
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'git exploded' });
  assert.equal(r.nexted, undefined, 'the error is answered here, not passed on');
});

test('a body parser refusal keeps its own status — a malformed body is the caller\'s bug', () => {
  const bad = Object.assign(new SyntaxError('Unexpected token }'), { status: 400 });
  const big = Object.assign(new Error('request entity too large'), { statusCode: 413 });
  assert.equal(through(bad).status, 400, 'not a 500 — the request was malformed, not the server');
  assert.equal(through(big).status, 413);
  // Anything outside the HTTP error range is a value we did not set and must not trust.
  assert.equal(through(Object.assign(new Error('x'), { status: 200 })).status, 500);
  assert.equal(through(Object.assign(new Error('x'), { status: 'nope' })).status, 500);
});

test('an error after the headers are out is handed on, never appended to the body', () => {
  const e = new Error('threw mid-stream');
  const r = through(e, { headersSent: true });
  assert.equal(r.status, null, 'an SSE stream must not get JSON stapled to it');
  assert.equal(r.body, null);
  assert.equal(r.nexted, e, 'express\'s default handler destroys the socket instead');
});

test('the failure log names the route but never the query string — that is where the token is', () => {
  const line = through(new Error('boom')).logs.join('\n');
  assert.ok(line.includes('GET /api/v1/state'), line);
  assert.ok(!line.includes('deadbeef'), 'the boot token rides in ?token= and must not be logged');
});

test('a non-Error throw does not become a second failure inside the handler', () => {
  // `null.message` is a TypeError raised *while* answering — which is exactly the
  // unhandled rejection this middleware exists to prevent.
  for (const thrown of [null, undefined, 'a string was thrown']) {
    const r = through(thrown);
    assert.equal(r.status, 500, String(thrown));
  }
});

test('a bare async handler that throws is a 500, and the process survives it', async () => {
  const app = express();
  // No wrapper. That is the assertion: express@5 awaits the handler itself.
  app.get('/api/boom', async () => { throw new Error('handler exploded'); });
  app.use(crash.routeErrors({ log: () => {} }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${(present(server.address()) as AddressInfo).port}/api/boom`);
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'handler exploded' });
  } finally { server.close(); }

  // The rejection was consumed by express, so it never reached the process handler
  // install() arms — which would have exited. Reaching this line is that proof.
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// the incident itself: a real daemon, a taken port
// ---------------------------------------------------------------------------

// Bind an ephemeral port and keep it. The daemon under test then cannot have it.
function occupy(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => resolve({
      port: (s.address() as AddressInfo).port,
      close: () => new Promise<void>((r) => { s.close(() => r()); }),
    }));
  });
}

test('a daemon that cannot bind its port exits non-zero instead of running on headless', { timeout: 60000 }, async () => {
  const held = await occupy();
  // Everything this daemon could write goes to throwaway dirs — never the user's.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-crash-'));
  const configFile = path.join(dir, 'config.json');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(configFile, JSON.stringify({ baseDirs: [], web: { host: '127.0.0.1', port: held.port } }));

  // WTS_UI=legacy pins this to `public/`, which is tracked in the repo. Without it the
  // test depends on `client/build` existing: a missing build is itself a fatal boot
  // error (webui.resolve), so on a fresh clone this daemon would exit non-zero for the
  // WRONG reason and the assertion below would report a confusing failure. This test is
  // about crash policy, not about which UI is served — so pin the part it doesn't care
  // about. If `public/` is ever removed, this needs a stub UI dir instead.
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server', 'server.ts')], {
    env: { ...process.env, WT_STUDIO_CONFIG: configFile, WT_STUDIO_STATE: stateDir, WTS_UI: 'legacy' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  present(child.stdout).on('data', (d) => { out += d; });
  present(child.stderr).on('data', (d) => { out += d; });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  // A daemon that swallows the bind failure never exits; don't wait forever for it.
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 25000);
  const r = await exited;
  clearTimeout(timer);
  await held.close();
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(r.signal, null, `the daemon had to be killed — it survived a failed bind:\n${out}`);
  assert.notEqual(r.code, 0, `expected a non-zero exit, got ${r.code}:\n${out}`);
  assert.ok(/already in use/.test(out), `expected the port to be named in the output:\n${out}`);
});
