// The terminal WebSocket: one browser socket ↔ one node-pty attached to the
// session's multiplexer. `/ws/term?session=<id>[&pane=split]`.
//
// Split out of server.ts the way the route modules are, because the ORDER of the
// four steps below is the whole of this file and it has to be exercisable without
// booting a daemon. `spawn` is injectable for exactly that reason.
import pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';

/** The session fields the attach reads — where the pty lands and what it attaches to. */
interface TerminalSession {
  muxName: string;
  worktreePath: string | null;
  repoPath: string;
}

/** The command `attachSpawn` hands back for node-pty to run. */
interface AttachSpec {
  file: string;
  args: string[];
  env?: { [key: string]: string | undefined };
}

interface TerminalMux {
  ensureSplit(name: string, opts: { cwd: string }): Promise<unknown>;
  attachSpawn(name: string, opts: { group?: string }): AttachSpec;
}

/**
 * the SessionManager, typed by the three things this file reaches for — the
 * surface a test double has to stand in for is exactly that and no more.
 */
interface TerminalManager {
  /** `undefined` as well as `null`: the real one is a Map lookup, as server/routes-review.ts also allows for. */
  get(id: string): TerminalSession | null | undefined;
  mux: TerminalMux;
}

/** The upgrade request, typed by the one field this handler reads. */
interface TerminalRequest {
  url?: string;
}

interface TerminalDeps {
  manager: TerminalManager;
  spawn?: typeof pty.spawn;
}

function createTerminalHandler({ manager, spawn = pty.spawn }: TerminalDeps) {
  return async function onConnection(ws: WebSocket, req: TerminalRequest): Promise<void> {
    const url = new URL(req.url || '', 'http://localhost');
    const id = url.searchParams.get('session');
    const pane = url.searchParams.get('pane');
    const cols = Number(url.searchParams.get('cols')) || 100;
    const rows = Number(url.searchParams.get('rows')) || 30;
    // `?session=` is optional in a URL but not to this handler: with no id there is no
    // session to attach to, and nothing below has anything to work with.
    if (!id) { ws.close(); return; }
    const s = manager.get(id);
    if (!s) { ws.close(); return; }

    // The listener that owns the pty's lifetime is installed BEFORE the first await,
    // not after the spawn.
    //
    // The split pane awaits ensureSplit — two tmux round-trips — and toggling the
    // split off is what closes this socket, so a close landing inside that await is
    // ordinary use, not a rarity. With the listener attached afterwards the event
    // had nobody to reach and was simply lost: the pty spawned anyway, its onData
    // threw into an empty catch on every keystroke, and onExit never fired because
    // `tmux attach-session` does not exit on its own. The result was an orphaned
    // node-pty plus an attached tmux client, for the daemon's life, per toggle.
    let term: IPty | null = null;
    let closed = false;
    ws.on('close', () => { closed = true; if (term) { try { term.kill(); } catch { /* */ } } });

    // The split pane attaches to the standalone `-split` session — a separate terminal
    // in the same worktree with its own tabs. Ensure it exists before the pty attaches.
    if (pane === 'split') { try { await manager.mux.ensureSplit(s.muxName, { cwd: s.worktreePath || s.repoPath }); } catch { /* */ } }
    if (closed) return; // the socket went away while tmux was answering — spawn nothing

    const spec = manager.mux.attachSpawn(s.muxName, pane === 'split' ? { group: 'split' } : {});
    // Nothing between here and the assignment may await, or the close listener above
    // would again be looking at a null `term` while one exists.
    //
    // The listeners below reach the pty through `attached` rather than `term`: they run
    // later than this line but nothing can prove that to a reader (or a type checker)
    // from a `let` that starts out null.
    const attached = spawn(spec.file, spec.args, {
      name: 'xterm-256color', cols, rows, cwd: s.worktreePath || s.repoPath, env: spec.env || process.env,
    });
    term = attached;
    attached.onData((d) => { try { ws.send(d); } catch { /* */ } });
    attached.onExit(() => { try { ws.close(); } catch { /* */ } });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { attached.write(data.toString('utf8')); return; }
      const txt = data.toString('utf8');
      try {
        const msg = JSON.parse(txt);
        if (msg.type === 'resize') { attached.resize(Math.max(2, msg.cols | 0), Math.max(2, msg.rows | 0)); return; }
        if (msg.type === 'input') { attached.write(msg.data); return; }
      } catch { attached.write(txt); }
    });
  };
}

export { createTerminalHandler };
