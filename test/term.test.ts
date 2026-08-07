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
import { TERM_CLOSE_DEAD } from '../server/types.ts';
import { present } from './helpers.ts';

// Just enough of a `ws`: close() emits 'close', exactly as the real one does when
// the browser goes away. `code` is recorded because the dead-session path is only
// distinguishable from an ordinary drop by the code it closes with.
class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;
  code: number | undefined;
  send(d: string) {
    if (this.closed) throw new Error('socket is closed');
    this.sent.push(d);
  }
  close(code?: number) {
    if (this.closed) return;
    this.closed = true;
    this.code = code;
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

function harness({
  session = SESSION,
  hasSession = async () => true,
}: {
  session?: TerminalSession;
  hasSession?: (name: string) => Promise<boolean>;
} = {}) {
  const terms: FakeTerm[] = [];
  const manager = {
    get: (id: string) => (id === 's1' ? session : null),
    mux: {
      hasSession,
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

/*
 * A session record outlives its tmux session — `reconcile()` marks it stopped, the
 * record stays so it can be resumed. Attaching to that name runs `tmux attach-session`
 * against nothing: tmux prints "can't find session: <name>" and exits, the pty's onExit
 * closes the socket, and the client reads an ordinary drop and reconnects. Forever.
 *
 * So the liveness question is asked HERE, before a pty exists to answer it by dying.
 */
test('a session whose mux session is gone says so instead of attaching to nothing', async () => {
  const { handler, terms } = harness({ hasSession: async () => false });
  const ws = new FakeSocket();
  await handler(ws, req('session=s1'));
  assert.equal(terms.length, 0, 'no pty is spawned for a session that cannot be attached');
  assert.equal(ws.closed, true);
  assert.equal(ws.code, TERM_CLOSE_DEAD, 'the code is what tells the client not to retry');
  assert.match(ws.sent.join(''), /Resume/, 'and the pane says what to do about it');
});

// Mirrors reconcile()'s rule: a query that ERRORS is not evidence the session is gone,
// and a transient tmux hiccup must not turn a live pane into "session ended".
test('a liveness check that throws attaches anyway', async () => {
  const { handler, terms } = harness({
    hasSession: async () => {
      throw new Error('tmux socket busy');
    },
  });
  const ws = new FakeSocket();
  await handler(ws, req('session=s1'));
  assert.equal(terms.length, 1);
  assert.equal(ws.closed, false);
});

/*
 * The liveness check is an await between the close listener and the spawn — which is
 * exactly the shape of the orphaned-pty bug the split pane used to have. A socket that
 * closes inside that window finds `term` still null, so the spawn below it has to be
 * the thing that doesn't happen; otherwise the pty (and its attached tmux client) lives
 * on for the daemon's life with nobody holding a reference to kill it.
 */
test('a socket that closes during the liveness check spawns nothing', async () => {
  let release: (alive: boolean) => void = () => {};
  const pending = new Promise<boolean>((r) => {
    release = r;
  });
  const { handler, terms } = harness({ hasSession: () => pending });
  const ws = new FakeSocket();
  const done = handler(ws, req('session=s1'));
  ws.close(); // browser goes away mid-check
  release(true); // ...and only then does tmux answer
  await done;
  assert.equal(terms.length, 0, 'the abandoned socket never gets a pty');
});

/*
 * A daemon started by launchd has no LANG: launchd sets none, and there is no terminal
 * to inherit one from. The pty then runs under a US-ASCII charmap where a powerline
 * glyph counts as three characters, so a prompt built from them is measured at three
 * times its width and wraps in the middle of itself. It reads as a broken terminal
 * rather than as a missing environment variable, which is why it is pinned here.
 */
test('a pty gets a UTF-8 locale even when the daemon has none', async () => {
  const { handler, terms } = harness();
  await handler(new FakeSocket(), req('session=s1'));
  assert.match(present(spawned(terms).args[2].env.LANG, 'a default locale'), /UTF-8$/);
});

test('a locale the environment already has is left alone — the default is not an override', async () => {
  const terms: FakeTerm[] = [];
  const manager = {
    get: () => SESSION,
    mux: {
      hasSession: async () => true,
      attachSpawn: () => ({ file: 'tmux', args: [], env: { LANG: 'fr_FR.UTF-8' } }),
    },
  };
  const handler = createTerminalHandler({
    manager,
    spawn: ((...a) => {
      const t = fakeTerm(a);
      terms.push(t);
      return t;
    }) as TerminalSpawn,
  });
  await handler(new FakeSocket(), req('session=s1'));
  assert.equal(spawned(terms).args[2].env.LANG, 'fr_FR.UTF-8');
});
