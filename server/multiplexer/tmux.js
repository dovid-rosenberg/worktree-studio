'use strict';
// tmux driver for the multiplexer interface. Rock-solid, scriptable, supports
// multiple concurrent clients (the "pop-out = embedded, mirrored" model).
const { run } = require('../util');

const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
function T(args) { return run('tmux', args, { env: ENV }); }

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
    const r = await T(['new-session', '-d', '-s', name, '-x', '220', '-y', '50', '-c', cwd || process.env.HOME]);
    if (r.code !== 0) return { created: false, error: r.stderr.trim() };
    // set env vars for the pane, then run the command
    if (env) for (const [k, v] of Object.entries(env)) await T(['set-environment', '-t', name, k, String(v)]);
    await T(['set-option', '-t', name, 'remain-on-exit', 'off']);
    await T(['send-keys', '-t', `${name}:0`, '--', persistCmd(cmd), 'Enter']);
    return { created: true };
  },

  // For node-pty: attach an interactive client to the session.
  attachSpawn(name, { popout = false } = {}) {
    if (popout) {
      // grouped session → independent sizing for a native window
      return { file: 'tmux', args: ['new-session', '-A', '-s', `${name}-popout`, '-t', name], env: ENV };
    }
    return { file: 'tmux', args: ['attach-session', '-t', name], env: ENV };
  },

  async newTab(name, { title, cwd, cmd } = {}) {
    const r = await T(['new-window', '-t', name, '-n', title || 'shell', '-c', cwd || process.env.HOME]);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
    if (cmd) await T(['send-keys', '-t', `${name}:${title || ''}`, '--', persistCmd(cmd), 'Enter']);
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

  async rename(oldName, newName) {
    return (await T(['rename-session', '-t', oldName, newName])).code === 0;
  },

  async kill(name) {
    await T(['kill-session', '-t', `=${name}`]);
    await T(['kill-session', '-t', `=${name}-popout`]);
    return true;
  },

  // shell command that a native terminal should run to attach (independent size)
  popoutCommand(name) {
    return `tmux new-session -A -s ${name}-popout -t ${name}`;
  },

  async selfTest() {
    const n = `wts-selftest-${process.pid}`;
    try {
      const e = await this.ensure(n, { cwd: process.env.HOME, cmd: 'true' });
      if (e.error) return false;
      const ok = await this.hasSession(n);
      return ok;
    } catch { return false; } finally { await this.kill(n); }
  },
};
