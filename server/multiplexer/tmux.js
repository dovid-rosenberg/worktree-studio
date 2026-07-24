'use strict';
// tmux driver for the multiplexer interface. Rock-solid, scriptable, clean 1:1
// tab indexing, and a grouped-session pop-out that doesn't orphan the embedded
// client. Runs on a dedicated socket with a chrome-free config (no status bar,
// no borders) so the embedded terminal reads native.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../util');

const SOCK = 'wt-studio';
const CONF = path.join(os.homedir(), '.config', 'worktree-studio', 'tmux.conf');
(function ensureConf() {
  try {
    fs.mkdirSync(path.dirname(CONF), { recursive: true });
    fs.writeFileSync(CONF, [
      'set -g status off', // no status bar → clean, native look
      'set -g mouse on',
      'set -g default-terminal "tmux-256color"',
      'setw -g pane-border-status off',
      'set -g base-index 0', // windows start at 0 → studio tab index maps 1:1
      'set -g renumber-windows on', // keep indices contiguous when a tab closes
      'set -g destroy-unattached off',
      'setw -g automatic-rename off', // keep our explicit tab names (claude/shell)
      'set -g allow-rename off', // don't let the running program rename the window
      'set -g window-size largest', // a smaller pop-out client never shrinks the embedded terminal
      'setw -g aggressive-resize on',
      '',
    ].join('\n'));
  } catch { /* */ }
})();

const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
function T(args) { return run('tmux', ['-L', SOCK, '-f', CONF, ...args], { env: ENV }); }

// Wrap a command so the pane survives the command exiting (drops to a shell).
function persistCmd(cmd) {
  return cmd ? `${cmd}; exec ${process.env.SHELL || '/bin/bash'} -l` : `${process.env.SHELL || '/bin/bash'} -l`;
}

module.exports = {
  name: 'tmux',
  env: ENV,

  async available() { return (await T(['-V'])).code === 0; },

  async hasSession(name) {
    return (await T(['has-session', '-t', `=${name}`])).code === 0;
  },

  async ensure(name, { cwd, cmd, env } = {}) {
    if (await this.hasSession(name)) return { created: false };
    const r = await T(['new-session', '-d', '-s', name, '-n', 'claude', '-x', '220', '-y', '50', '-c', cwd || process.env.HOME]);
    if (r.code !== 0) return { created: false, error: r.stderr.trim() };
    // set env vars for the pane, then run the command
    if (env) for (const [k, v] of Object.entries(env)) await T(['set-environment', '-t', name, k, String(v)]);
    await T(['set-option', '-t', name, 'remain-on-exit', 'off']);
    await T(['send-keys', '-t', `${name}:0`, '--', persistCmd(cmd), 'Enter']);
    return { created: true };
  },

  // For node-pty: attach an interactive client to the session.
  attachSpawn(name, { popout = false } = {}) {
    const base = ['-L', SOCK];
    if (popout) {
      // grouped session → independent size, and closing it never orphans the embed
      return { file: 'tmux', args: [...base, 'new-session', '-A', '-s', `${name}-popout`, '-t', name], env: ENV };
    }
    return { file: 'tmux', args: [...base, 'attach-session', '-t', name], env: ENV };
  },

  async newTab(name, { title, cwd, cmd } = {}) {
    const r = await T(['new-window', '-t', name, '-n', title || 'shell', '-c', cwd || process.env.HOME]);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
    // new-window selects the new window → send the command to the session's active window
    if (cmd) await T(['send-keys', '-t', name, '--', persistCmd(cmd), 'Enter']);
    return { ok: true };
  },

  async listTabs(name) {
    const r = await T(['list-windows', '-t', name, '-F', '#{window_index}\t#{window_name}\t#{window_active}']);
    if (r.code !== 0) return [];
    return r.stdout.trim().split('\n').filter(Boolean).map((l) => {
      const [index, wname, active] = l.split('\t');
      return { id: index, title: wname, active: active === '1' };
    });
  },

  async capture(name, target = '0') {
    const r = await T(['capture-pane', '-t', `${name}:${target}`, '-p']);
    return r.code === 0 ? r.stdout : '';
  },

  async sendText(name, text, target = '0') {
    return T(['send-keys', '-t', `${name}:${target}`, '--', text, 'Enter']);
  },

  async selectTab(name, id) {
    return (await T(['select-window', '-t', `${name}:${id}`])).code === 0;
  },

  async closeTab(name, id) {
    return (await T(['kill-window', '-t', `${name}:${id}`])).code === 0;
  },

  async rename(oldName, newName) {
    return (await T(['rename-session', '-t', oldName, newName])).code === 0;
  },

  async kill(name) {
    await T(['kill-session', '-t', `=${name}`]);
    await T(['kill-session', '-t', `=${name}-popout`]);
    return true;
  },

  // shell command a native terminal runs to attach — a grouped session, so closing
  // the native window never disconnects the embedded client.
  popoutCommand(name) {
    return `tmux -L ${SOCK} new-session -A -s ${name}-popout -t ${name}`;
  },
};
