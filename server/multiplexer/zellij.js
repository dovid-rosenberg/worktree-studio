'use strict';
// zellij driver. zellij 0.44+ gives persistent, self-resurrecting, multi-client
// sessions with a scriptable `action` CLI. Preferred substrate when it passes
// its self-test; otherwise the app falls back to tmux automatically.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../util');

// macOS $TMPDIR is long and zellij's IPC socket path has a 103-byte limit, so
// pin a short socket dir. Must be identical everywhere the session is reached —
// including the pop-out command that runs in a native terminal.
const SOCKET_DIR = process.env.ZELLIJ_SOCKET_DIR || '/tmp/zellij';

// Clean, native-looking embedded terminal: hide zellij's pane frames, tab bar
// and status bar via a studio-owned config + a no-chrome layout (studio renders
// its own tab strip, so zellij's UI is redundant).
const CFG_DIR = path.join(os.homedir(), '.config', 'worktree-studio', 'zellij');
const LAYOUT_DIR = path.join(CFG_DIR, 'layouts');
const CONFIG_FILE = path.join(CFG_DIR, 'config.kdl');
(function ensureCleanConfig() {
  try {
    fs.mkdirSync(LAYOUT_DIR, { recursive: true });
    // no tab-bar / status-bar plugins in the template → no chrome
    fs.writeFileSync(path.join(LAYOUT_DIR, 'wtclean.kdl'), 'layout {\n    default_tab_template {\n        children\n    }\n}\n');
    fs.writeFileSync(CONFIG_FILE, `pane_frames false\nlayout_dir "${LAYOUT_DIR}"\ndefault_layout "wtclean"\n`);
  } catch { /* */ }
})();

const ENV = { ...process.env, ZELLIJ_SOCKET_DIR: SOCKET_DIR, ZELLIJ_CONFIG_FILE: CONFIG_FILE, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
function Z(args) { return run('zellij', args, { env: ENV }); }

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

function tabLayout(cwd, cmd) {
  const shell = process.env.SHELL || '/bin/bash';
  const inner = cmd ? `${cmd}; exec ${shell} -l` : `exec ${shell} -l`;
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `layout {\n    pane cwd="${esc(cwd || os.homedir())}" command="${shell}" {\n        args "-lc" "${esc(inner)}"\n    }\n}\n`;
}

function writeLayout(cwd, cmd) {
  const f = path.join(os.tmpdir(), `wts-layout-${process.pid}-${Math.floor(process.hrtime()[1] / 1000)}.kdl`);
  fs.writeFileSync(f, tabLayout(cwd, cmd));
  return f;
}

module.exports = {
  name: 'zellij',
  env: ENV,

  async available() { return (await Z(['--version'])).code === 0; },

  async listSessions() {
    const r = await Z(['list-sessions', '--no-formatting']);
    if (r.code !== 0) return [];
    return r.stdout.split('\n').map((l) => stripAnsi(l).trim()).filter(Boolean).map((l) => {
      const name = l.split(/\s+/)[0];
      return { name, exited: /EXITED/i.test(l) };
    });
  },

  async hasSession(name) {
    return (await this.listSessions()).some((s) => s.name === name && !s.exited);
  },

  async ensure(name, { cwd, cmd } = {}) {
    const sessions = await this.listSessions();
    const existing = sessions.find((s) => s.name === name);
    if (existing && !existing.exited) return { created: false };
    // create a detached (background) session, then load a tab that runs cmd
    const c = await Z(['attach', '--create-background', name]);
    if (c.code !== 0) return { created: false, error: c.stderr.trim() };
    const layout = writeLayout(cwd, cmd);
    const t = await Z(['--session', name, 'action', 'new-tab', '--layout', layout, '--name', 'claude']);
    try { fs.unlinkSync(layout); } catch { /* */ }
    // remove the empty default tab so our claude tab is tab 1 (studio's tab strip
    // then maps 1:1 to zellij's tabs)
    await Z(['--session', name, 'action', 'go-to-tab', '1']);
    await Z(['--session', name, 'action', 'close-tab']);
    if (t.code !== 0) return { created: true, warn: t.stderr.trim() };
    return { created: true };
  },

  attachSpawn(name) {
    return { file: 'zellij', args: ['attach', name], env: { ...ENV, TERM: 'xterm-256color' } };
  },

  async newTab(name, { title, cwd, cmd } = {}) {
    const layout = writeLayout(cwd, cmd);
    const r = await Z(['--session', name, 'action', 'new-tab', '--layout', layout, '--name', title || 'shell']);
    try { fs.unlinkSync(layout); } catch { /* */ }
    return { ok: r.code === 0, error: r.stderr.trim() };
  },

  async listTabs(name) {
    const r = await Z(['--session', name, 'action', 'query-tab-names']);
    if (r.code !== 0) return [];
    return r.stdout.split('\n').map((s) => stripAnsi(s).trim()).filter(Boolean)
      .map((title, i) => ({ id: String(i), title, active: false }));
  },

  async capture(name) {
    const f = path.join(os.tmpdir(), `wts-dump-${process.pid}-${Math.floor(process.hrtime()[1] / 1000)}.txt`);
    const r = await Z(['--session', name, 'action', 'dump-screen', f]);
    if (r.code !== 0) return '';
    try { const t = fs.readFileSync(f, 'utf8'); fs.unlinkSync(f); return t; } catch { return ''; }
  },

  async sendText(name, text) {
    await Z(['--session', name, 'action', 'write-chars', text]);
    await Z(['--session', name, 'action', 'write', '13']); // Enter (CR)
    return { code: 0 };
  },

  async selectTab(name, id) {
    return (await Z(['--session', name, 'action', 'go-to-tab', String(Number(id) + 1)])).code === 0;
  },

  async closeTab(name, id) {
    await Z(['--session', name, 'action', 'go-to-tab', String(Number(id) + 1)]);
    return (await Z(['--session', name, 'action', 'close-tab'])).code === 0;
  },

  async rename(oldName, newName) {
    // best-effort; not all zellij builds expose session rename
    const r = await Z(['--session', oldName, 'action', 'rename-session', newName]);
    return r.code === 0;
  },

  async kill(name) {
    await Z(['kill-session', name]);
    await Z(['delete-session', name, '--force']);
    return true;
  },

  popoutCommand(name) { return `ZELLIJ_SOCKET_DIR=${SOCKET_DIR} ZELLIJ_CONFIG_FILE=${CONFIG_FILE} zellij attach ${name}`; },

  async selfTest() {
    const n = `wts-selftest-${process.pid}`;
    try {
      const e = await this.ensure(n, { cwd: os.homedir(), cmd: 'true' });
      if (e.error) return false;
      // give the background session a beat to register
      await new Promise((r) => setTimeout(r, 400));
      const sessions = await this.listSessions();
      return sessions.some((s) => s.name === n);
    } catch { return false; } finally { await this.kill(n); }
  },
};
