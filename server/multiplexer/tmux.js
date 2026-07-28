// tmux driver for the multiplexer interface. Rock-solid, scriptable, clean 1:1
// tab indexing, and a grouped-session pop-out that doesn't orphan the embedded
// client. Runs on a dedicated socket with a chrome-free config (no status bar,
// no borders) so the embedded terminal reads native.
import fs from 'fs';
import path from 'path';
import { run } from '../util.ts';
import { CONFIG_DIR } from '../config.js';

const SOCK = 'wt-studio';
// CONFIG_DIR, not a second hand-rolled ~/.config/worktree-studio: that spelling
// ignored WT_STUDIO_CONFIG_DIR, so setting the env var moved config.json and left
// tmux.conf behind in the default location.
const CONF = path.join(CONFIG_DIR, 'tmux.conf');
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

export default {
  name: 'tmux',
  env: ENV,

  async available() { return (await T(['-V'])).code === 0; },

  async hasSession(name) {
    return (await T(['has-session', '-t', `=${name}`])).code === 0;
  },

  /** @param {string} name @param {{ cwd?: string, cmd?: string, env?: Record<string, any> }} [opts] */
  async ensure(name, { cwd, cmd, env } = {}) {
    if (await this.hasSession(name)) return { created: false };
    // Pass env in new-session itself (-e KEY=VAL, tmux ≥3.2) so window 0's shell —
    // and the claude launched into it — inherits it. set-environment AFTER new-session
    // is too late: window 0 already spawned without the vars.
    const envArgs = [];
    if (env) for (const [k, v] of Object.entries(env)) envArgs.push('-e', `${k}=${String(v)}`);
    const r = await T(['new-session', '-d', '-s', name, '-n', 'claude', '-x', '220', '-y', '50', '-c', cwd || process.env.HOME, ...envArgs]);
    if (r.code !== 0) return { created: false, error: r.stderr.trim() };
    await T(['set-option', '-t', name, 'remain-on-exit', 'off']);
    await T(['send-keys', '-t', `${name}:0`, '--', persistCmd(cmd), 'Enter']);
    return { created: true };
  },

  // For node-pty: attach an interactive client to the session.
  //  - popout: a GROUPED session (`-t name`) — a native window mirroring the same
  //    live session, which is exactly what "pop out to a terminal" should do.
  //  - split: attach the embedded second pane to the `-split` session — a SEPARATE,
  //    standalone tmux session (not grouped) with its own window list. It's just
  //    "another terminal" in the same worktree, with its own independent tabs, so
  //    nothing mirrors the primary. Call ensureSplit(name, {cwd}) first.
  //  - default: attach the embedded primary client to the session.
  /** @param {string} name @param {{ popout?: boolean, group?: string }} [opts] */
  attachSpawn(name, { popout = false, group } = {}) {
    const base = ['-L', SOCK];
    if (popout) {
      return { file: 'tmux', args: [...base, 'new-session', '-A', '-s', `${name}-popout`, '-t', name], env: ENV };
    }
    if (group === 'split') {
      return { file: 'tmux', args: [...base, 'attach-session', '-t', `${name}-split`], env: ENV };
    }
    return { file: 'tmux', args: [...base, 'attach-session', '-t', name], env: ENV };
  },

  // Ensure the standalone `-split` session exists with its own shell window. It is
  // independent of the primary (not grouped): its own tabs, no shared windows. Tab
  // ops (newTab/selectTab/closeTab/listTabs) target `${name}-split` and just work.
  /** @param {string} name @param {{ cwd?: string }} [opts] */
  async ensureSplit(name, { cwd } = {}) {
    if (await this.hasSession(`${name}-split`)) return;
    await T(['new-session', '-d', '-s', `${name}-split`, '-n', 'shell', '-x', '220', '-y', '50', '-c', cwd || process.env.HOME]);
    await T(['set-option', '-t', `${name}-split`, 'remain-on-exit', 'off']);
  },

  /** @param {string} name @param {{ title?: string, cwd?: string, cmd?: string }} [opts] */
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
    const t = `${name}:${target}`;
    // Send the body literally (-l) so tmux never interprets a token like `;`, `Enter`,
    // or `C-c` inside a prompt as a key. Submit with a SEPARATE explicit Enter.
    await T(['send-keys', '-t', t, '-l', '--', text]);
    return T(['send-keys', '-t', t, 'Enter']);
  },

  // Foreground program in a pane (e.g. 'node'/'claude' when claude is up, a shell
  // name like 'zsh' when it isn't). Used to gate live keystroke injection.
  async paneCommand(name, target = '0') {
    const r = await T(['display-message', '-p', '-t', `${name}:${target}`, '#{pane_current_command}']);
    return r.code === 0 ? r.stdout.trim() : '';
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
    await T(['kill-session', '-t', `=${name}-split`]);
    return true;
  },

  // shell command a native terminal runs to attach — a grouped session, so closing
  // the native window never disconnects the embedded client.
  popoutCommand(name) {
    return `tmux -L ${SOCK} new-session -A -s ${name}-popout -t ${name}`;
  },
};
