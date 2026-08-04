// The terminal WebSocket: one browser socket ↔ one node-pty attached to the
// session's multiplexer. `/ws/term?session=<id>`.
//
// Split out of server.ts the way the route modules are, because the ORDER of the
// four steps below is the whole of this file and it has to be exercisable without
// booting a daemon. `spawn` is injectable for exactly that reason.
import pty from 'node-pty';
import type { RawData } from 'ws';

/**
 * The browser socket, typed by the four members this handler uses rather than as
 * `ws`'s `WebSocket` — a class with 22 more. A real WebSocket satisfies it, and so
 * can a hand-rolled EventEmitter, which is what test/term.test.ts drives it with.
 */
export interface TerminalSocket {
  send(data: string): void;
  close(): void;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): unknown;
}

/**
 * The pty, typed the same way: the five members the handler touches. `node-pty`'s
 * `IPty` satisfies it.
 */
export interface TerminalPty {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** What spawns one. `pty.spawn` satisfies it. */
export type TerminalSpawn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
) => TerminalPty;

/** The session fields the attach reads — where the pty lands and what it attaches to. */
export interface TerminalSession {
  muxName: string;
  worktreePath: string | null;
  repoPath: string;
}

/** The command `attachSpawn` hands back for node-pty to run. */
export interface AttachSpec {
  file: string;
  args: string[];
  env?: { [key: string]: string | undefined };
}

export interface TerminalMux {
  attachSpawn(name: string): AttachSpec;
}

/**
 * the SessionManager, typed by the three things this file reaches for — the
 * surface a test double has to stand in for is exactly that and no more.
 */
export interface TerminalManager {
  /** `undefined` as well as `null`: the real one is a Map lookup, as server/routes-review.ts also allows for. */
  get(id: string): TerminalSession | null | undefined;
  mux: TerminalMux;
}

/** The upgrade request, typed by the one field this handler reads. */
export interface TerminalRequest {
  url?: string;
}

export interface TerminalDeps {
  manager: TerminalManager;
  spawn?: TerminalSpawn;
}

function createTerminalHandler({ manager, spawn = pty.spawn }: TerminalDeps) {
  return async function onConnection(ws: TerminalSocket, req: TerminalRequest): Promise<void> {
    const url = new URL(req.url || '', 'http://localhost');
    const id = url.searchParams.get('session');
    const cols = Number(url.searchParams.get('cols')) || 100;
    const rows = Number(url.searchParams.get('rows')) || 30;
    // `?session=` is optional in a URL but not to this handler: with no id there is no
    // session to attach to, and nothing below has anything to work with.
    if (!id) {
      ws.close();
      return;
    }
    const s = manager.get(id);
    if (!s) {
      ws.close();
      return;
    }

    // The listener that owns the pty's lifetime is installed BEFORE the spawn.
    //
    // A close arriving after the spawn has to find something to kill. Attached
    // afterwards, the event had nobody to reach and was simply lost: the pty lived on,
    // its onData threw into an empty catch on every keystroke, and onExit never fired
    // because `tmux attach-session` does not exit on its own. The result was an orphaned
    // node-pty plus an attached tmux client, for the daemon's life, per socket.
    //
    // There used to be a `closed` flag checked here as well, because the split pane
    // awaited ensureSplit between this line and the spawn. The split is gone and with it
    // the await, so nothing can interleave and the flag could never be true.
    let term: TerminalPty | null = null;
    ws.on('close', () => {
      if (term) {
        try {
          term.kill();
        } catch {
          /* */
        }
      }
    });

    const spec = manager.mux.attachSpawn(s.muxName);
    // Nothing between here and the assignment may await, or the close listener above
    // would again be looking at a null `term` while one exists.
    //
    // The listeners below reach the pty through `attached` rather than `term`: they run
    // later than this line but nothing can prove that to a reader (or a type checker)
    // from a `let` that starts out null.
    const attached = spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: s.worktreePath || s.repoPath,
      env: spec.env || process.env,
    });
    term = attached;
    attached.onData((d) => {
      try {
        ws.send(d);
      } catch {
        /* */
      }
    });
    attached.onExit(() => {
      try {
        ws.close();
      } catch {
        /* */
      }
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        attached.write(data.toString('utf8'));
        return;
      }
      const txt = data.toString('utf8');
      try {
        const msg = JSON.parse(txt);
        if (msg.type === 'resize') {
          attached.resize(Math.max(2, msg.cols | 0), Math.max(2, msg.rows | 0));
          return;
        }
        if (msg.type === 'input') {
          attached.write(msg.data);
          return;
        }
      } catch {
        attached.write(txt);
      }
    });
  };
}

export { createTerminalHandler };
