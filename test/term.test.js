'use strict';
// server/term.js: the terminal WebSocket's resource ordering.
//
// The thing under test is a race, so ensureSplit is a promise this file resolves
// by hand — that is what lets the socket close at the exact moment the real bug
// needed (during the tmux round-trips, before any pty exists).
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createTerminalHandler } = require('../server/term');

// Just enough of a `ws`: close() emits 'close', exactly as the real one does when
// the browser goes away.
class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.closed = false; }
  send(d) { if (this.closed) throw new Error('socket is closed'); this.sent.push(d); }
  close() { if (this.closed) return; this.closed = true; this.emit('close'); }
}

function fakeTerm() {
  const t = {
    killed: 0, written: [], resized: null,
    onData(fn) { t._data = fn; },
    onExit(fn) { t._exit = fn; },
    write(d) { t.written.push(d); },
    resize(c, r) { t.resized = [c, r]; },
    kill() { t.killed += 1; },
  };
  return t;
}

// `ensureSplit` hands back a promise the test resolves when it wants the await to
// finish; `terms` records every pty that was actually spawned.
function harness({ session = { muxName: 'wts-x', worktreePath: '/wt' } } = {}) {
  const terms = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const manager = {
    get: (id) => (id === 's1' ? session : null),
    mux: {
      ensureSplit: () => gate,
      attachSpawn: (name, opts) => ({ file: 'tmux', args: ['attach-session', '-t', opts.group === 'split' ? `${name}-split` : name], env: {} }),
    },
  };
  const handler = createTerminalHandler({ manager, spawn: /** @type {any} */ ((/** @type {any[]} */ ...a) => { const t = fakeTerm(); t.args = a; terms.push(t); return t; }) });
  return { handler, terms, release, manager };
}

const req = (qs) => ({ url: `/ws/term?${qs}` });

test('a split socket that closes during ensureSplit spawns no pty at all', async () => {
  const { handler, terms, release } = harness();
  const ws = new FakeSocket();
  const done = handler(ws, req('session=s1&pane=split'));
  // The browser goes away while tmux is still answering — this is what toggling the
  // split pane off does.
  ws.close();
  release();
  await done;
  assert.equal(terms.length, 0, 'no pty may be spawned for a socket that is already gone');
});

test('a split socket that survives ensureSplit gets its pty, and closing kills it', async () => {
  const { handler, terms, release } = harness();
  const ws = new FakeSocket();
  const done = handler(ws, req('session=s1&pane=split'));
  release();
  await done;
  assert.equal(terms.length, 1, 'the pty is spawned once tmux has answered');
  assert.deepEqual(terms[0].args[1], ['attach-session', '-t', 'wts-x-split'], 'attaches the -split session');
  assert.equal(terms[0].killed, 0);
  ws.close();
  assert.equal(terms[0].killed, 1, 'closing the socket kills the pty');
});

test('the non-split path still spawns, forwards output and kills on close', async () => {
  const { handler, terms } = harness();
  const ws = new FakeSocket();
  await handler(ws, req('session=s1&cols=80&rows=24'));
  assert.equal(terms.length, 1);
  assert.deepEqual(terms[0].args[1], ['attach-session', '-t', 'wts-x'], 'attaches the primary session');
  assert.equal(terms[0].args[2].cols, 80);
  assert.equal(terms[0].args[2].rows, 24);
  terms[0]._data('hello');
  assert.deepEqual(ws.sent, ['hello']);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'ls\r' })), false);
  assert.deepEqual(terms[0].written, ['ls\r']);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })), false);
  assert.deepEqual(terms[0].resized, [120, 40]);
  ws.close();
  assert.equal(terms[0].killed, 1);
});

test('an unknown session closes the socket without spawning anything', async () => {
  const { handler, terms } = harness();
  const ws = new FakeSocket();
  await handler(ws, req('session=nope'));
  assert.equal(terms.length, 0);
  assert.equal(ws.closed, true);
});
