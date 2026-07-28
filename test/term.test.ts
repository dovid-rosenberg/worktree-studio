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
  send(d: string) { if (this.closed) throw new Error('socket is closed'); this.sent.push(d); }
  close() { if (this.closed) return; this.closed = true; this.emit('close'); }
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
    killed: 0, written: [], resized: null, args,
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
const SESSION: TerminalSession = { muxName: 'wts-x', worktreePath: '/wt', repoPath: '/repo' };

function harness({ session = SESSION }: { session?: TerminalSession } = {}) {
  const terms: FakeTerm[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const manager = {
    get: (id: string) => (id === 's1' ? session : null),
    mux: {
      ensureSplit: () => gate,
      attachSpawn: (name: string, opts: { group?: string }) =>
        ({ file: 'tmux', args: ['attach-session', '-t', opts.group === 'split' ? `${name}-split` : name], env: {} }),
    },
  };
  const spawn: TerminalSpawn = (...a) => { const t = fakeTerm(a); terms.push(t); return t; };
  const handler = createTerminalHandler({ manager, spawn });
  return { handler, terms, release, manager };
}

const req = (qs: string) => ({ url: `/ws/term?${qs}` });
/** The pty the test just caused to be spawned. */
const spawned = (terms: FakeTerm[], i = 0) => present(terms[i], `pty #${i}`);

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
  assert.deepEqual(spawned(terms).args[1], ['attach-session', '-t', 'wts-x-split'], 'attaches the -split session');
  assert.equal(spawned(terms).killed, 0);
  ws.close();
  assert.equal(spawned(terms).killed, 1, 'closing the socket kills the pty');
});

test('the non-split path still spawns, forwards output and kills on close', async () => {
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
