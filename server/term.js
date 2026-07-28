'use strict';
// The terminal WebSocket: one browser socket ↔ one node-pty attached to the
// session's multiplexer. `/ws/term?session=<id>[&pane=split]`.
//
// Split out of server.js the way the route modules are, because the ORDER of the
// four steps below is the whole of this file and it has to be exercisable without
// booting a daemon. `spawn` is injectable for exactly that reason.
const pty = require('node-pty');

/**
 * @param {object} deps
 * @param {InstanceType<typeof import('./sessions').SessionManager>} deps.manager
 * @param {typeof pty.spawn} [deps.spawn]
 */
function createTerminalHandler({ manager, spawn = pty.spawn }) {
  return async function onConnection(ws, req) {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('session');
    const pane = url.searchParams.get('pane');
    const cols = Number(url.searchParams.get('cols')) || 100;
    const rows = Number(url.searchParams.get('rows')) || 30;
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
    let term = null;
    let closed = false;
    ws.on('close', () => { closed = true; if (term) { try { term.kill(); } catch { /* */ } } });

    // The split pane attaches to the standalone `-split` session — a separate terminal
    // in the same worktree with its own tabs. Ensure it exists before the pty attaches.
    if (pane === 'split') { try { await manager.mux.ensureSplit(s.muxName, { cwd: s.worktreePath || s.repoPath }); } catch { /* */ } }
    if (closed) return; // the socket went away while tmux was answering — spawn nothing

    const spec = manager.mux.attachSpawn(s.muxName, pane === 'split' ? { group: 'split' } : {});
    // Nothing between here and the assignment may await, or the close listener above
    // would again be looking at a null `term` while one exists.
    term = spawn(spec.file, spec.args, {
      name: 'xterm-256color', cols, rows, cwd: s.worktreePath || s.repoPath, env: spec.env || process.env,
    });
    term.onData((d) => { try { ws.send(d); } catch { /* */ } });
    term.onExit(() => { try { ws.close(); } catch { /* */ } });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { term.write(data.toString('utf8')); return; }
      const txt = data.toString('utf8');
      try {
        const msg = JSON.parse(txt);
        if (msg.type === 'resize') { term.resize(Math.max(2, msg.cols | 0), Math.max(2, msg.rows | 0)); return; }
        if (msg.type === 'input') { term.write(msg.data); return; }
      } catch { term.write(txt); }
    });
  };
}

module.exports = { createTerminalHandler };
