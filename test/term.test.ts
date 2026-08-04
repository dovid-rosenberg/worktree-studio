// server/term.ts: the terminal WebSocket's resource ordering.
//
// The thing under test is a race, so ensureSplit is a promise this file resolves
// by hand — that is what lets the socket close at the exact moment the real bug
// needed (during the tmux round-trips, before any pty exists).
import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import { createTerminalHandler } from '../server/term.ts';
import type { TerminalPty, TerminalSession, TerminalSpawn } from '../server/term.ts';
import { present } from './helpers.ts';

// Just enough of a `ws`: close() emits 'close', exactly as the real one does when
// the browser goes away.
class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;
  send(d: string) {
    if (this.closed) throw new Error('socket is closed');
    this.sent.push(d);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

// A pty stand-in that also records what it was spawned WITH (`args`) and exposes the
// listeners the handler installed (`_data` / `_exit`), so a test can drive output from
// the pty side.
interface FakeTerm extends TerminalPty {
  killed: number;
  written: string[];
  resized: [number, number] | null;
  args: Parameters<TerminalSpawn>;
  _data?: (d: string) => void;
  _exit?: (e: { exitCode: number }) => void;
}
function fakeTerm(args: Parameters<TerminalSpawn>): FakeTerm {
  const t: FakeTerm = {
    killed: 0,
    written: [],
    resized: null,
    args,
    onData(fn) {
      t._data = fn;
    },
    onExit(fn) {
      t._exit = fn;
    },
    write(d) {
      t.written.push(d);
    },
    resize(c, r) {
      t.resized = [c, r];
    },
    kill() {
      t.killed += 1;
    },
  };
  return t;
}

// `ensureSplit` hands back a promise the test resolves when it wants the await to
// finish; `terms` records every pty that was actually spawned.
const SESSION: TerminalSession = { muxName: 'wts-x', worktreePath: '/wt', repoPath: '/repo' };

function harness({ session = SESSION }: { session?: TerminalSession } = {}) {
  const terms: FakeTerm[] = [];
  const manager = {
    get: (id: string) => (id === 's1' ? session : null),
    mux: {
      attachSpawn: (name: string) => ({ file: 'tmux', args: ['attach-session', '-t', name], env: {} }),
    },
  };
  const spawn: TerminalSpawn = (...a) => {
    const t = fakeTerm(a);
    terms.push(t);
    return t;
  };
  const handler = createTerminalHandler({ manager, spawn });
  return { handler, terms, manager };
}

const req = (qs: string) => ({ url: `/ws/term?${qs}` });
/** The pty the test just caused to be spawned. */
const spawned = (terms: FakeTerm[], i = 0) => present(terms[i], `pty #${i}`);

/*
 * Two tests here used to pin a race in the split pane: it awaited ensureSplit between
 * the close listener and the spawn, so a socket closing inside that await had to spawn
 * no pty. The split pane is gone and so is the await — nothing can interleave any more,
 * so the race is unrepresentable rather than untested. What still matters is below: the
 * listener is installed before the spawn, so a close always finds a pty to kill.
 */
test('a socket spawns its pty, forwards output and kills it on close', async () => {
  const { handler, terms } = harness();
  const ws = new FakeSocket();
  await handler(ws, req('session=s1&cols=80&rows=24'));
  assert.equal(terms.length, 1);
  assert.deepEqual(spawned(terms).args[1], ['attach-session', '-t', 'wts-x'], 'attaches the primary session');
  assert.equal(spawned(terms).args[2].cols, 80);
  assert.equal(spawned(terms).args[2].rows, 24);
  present(spawned(terms)._data, 'the onData listener')('hello');
  assert.deepEqual(ws.sent, ['hello']);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'ls\r' })), false);
  assert.deepEqual(spawned(terms).written, ['ls\r']);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })), false);
  assert.deepEqual(spawned(terms).resized, [120, 40]);
  ws.close();
  assert.equal(spawned(terms).killed, 1);
});

test('an unknown session closes the socket without spawning anything', async () => {
  const { handler, terms } = harness();
  const ws = new FakeSocket();
  await handler(ws, req('session=nope'));
  assert.equal(terms.length, 0);
  assert.equal(ws.closed, true);
});
