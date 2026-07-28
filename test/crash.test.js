'use strict';
// Crash policy (server/crash.js) + the thing it exists to prevent: a daemon whose
// listen() failed staying alive with no HTTP server.
//
// The unit half drives the classification through injected process hooks, so no
// real handler is armed and the test runner is never killed. The integration half
// boots the REAL server against an occupied port, in a throwaway config/state dir,
// and asserts it exits non-zero — that is the incident, reproduced.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crash = require('../server/crash');

// Arm install() against fakes and return what it did.
function armed() {
  const handlers = new Map();
  const logs = [];
  const exits = [];
  crash.install({
    log: (...a) => logs.push(a.map((x) => (x instanceof Error ? `${x.code || ''} ${x.message}` : String(x))).join(' ')),
    exit: (c) => exits.push(c),
    on: (name, fn) => handlers.set(name, fn),
  });
  return { handlers, logs, exits };
}

function err(code, message = 'boom') {
  const e = new Error(message);
  e.code = code;
  return e;
}

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
  handlers.get('uncaughtException')(err('EADDRINUSE', 'listen EADDRINUSE'));
  assert.deepEqual(exits, [1], 'a failed bind must be fatal');
});

test('an uncaught programming error exits non-zero', () => {
  const { handlers, exits, logs } = armed();
  handlers.get('uncaughtException')(new TypeError('x is not a function'));
  assert.deepEqual(exits, [1]);
  assert.ok(logs.join('\n').includes('fatal uncaughtException'), logs.join('\n'));
});

test('an unhandled rejection is fatal too — it is the same failure reached through await', () => {
  const { handlers, exits } = armed();
  handlers.get('unhandledRejection')(new Error('nobody caught me'));
  assert.deepEqual(exits, [1]);
});

test('a client that vanished mid-write is survived, not fatal', () => {
  const { handlers, exits, logs } = armed();
  handlers.get('uncaughtException')(err('EPIPE', 'write EPIPE'));
  handlers.get('unhandledRejection')(err('ECONNRESET', 'read ECONNRESET'));
  assert.deepEqual(exits, [], 'one dead SSE/WebSocket socket must not take the daemon down');
  assert.equal(logs.length, 2);
  assert.ok(logs.every((l) => l.includes('continuing')), logs.join('\n'));
});

// ---------------------------------------------------------------------------
// guardListen
// ---------------------------------------------------------------------------

test('guardListen turns a bind failure into an explained non-zero exit', () => {
  const { EventEmitter } = require('events');
  const server = new EventEmitter();
  const logs = []; const exits = [];
  crash.guardListen(server, { host: '127.0.0.1', port: 4300 }, { log: (...a) => logs.push(String(a[0])), exit: (c) => exits.push(c) });
  server.emit('error', err('EADDRINUSE', 'listen EADDRINUSE 127.0.0.1:4300'));
  assert.deepEqual(exits, [1]);
  assert.ok(/port 4300 is already in use/.test(logs.join('\n')), logs.join('\n'));
});

test('listenErrorMessage names the remedy for each bind failure and ignores the rest', () => {
  assert.match(crash.listenErrorMessage(err('EADDRINUSE'), { host: '127.0.0.1', port: 4300 }), /already in use/);
  assert.match(crash.listenErrorMessage(err('EACCES'), { host: '127.0.0.1', port: 80 }), /web\.port/);
  assert.equal(crash.listenErrorMessage(err('EPIPE'), { port: 1 }), null);
  assert.equal(crash.listenErrorMessage(null, {}), null);
});

// ---------------------------------------------------------------------------
// the incident itself: a real daemon, a taken port
// ---------------------------------------------------------------------------

// Bind an ephemeral port and keep it. The daemon under test then cannot have it.
function occupy() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => new Promise((r) => s.close(r)) }));
  });
}

test('a daemon that cannot bind its port exits non-zero instead of running on headless', { timeout: 60000 }, async () => {
  const held = await occupy();
  // Everything this daemon could write goes to throwaway dirs — never the user's.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-crash-'));
  const configFile = path.join(dir, 'config.json');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(configFile, JSON.stringify({ baseDirs: [], web: { host: '127.0.0.1', port: held.port } }));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, WT_STUDIO_CONFIG: configFile, WT_STUDIO_STATE: stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
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
