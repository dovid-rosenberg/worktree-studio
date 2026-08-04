// tmux driver for the multiplexer interface. Rock-solid, scriptable, clean 1:1
// tab indexing, and a grouped-session pop-out that doesn't orphan the embedded
// client. Runs on a dedicated socket with a chrome-free config (no status bar,
// no borders) so the embedded terminal reads native.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { run } from '../util.ts';
import type { RunResult } from '../util.ts';
import { CONFIG_DIR } from '../config.ts';

/** The command `attachSpawn` hands back for node-pty to run. */
export interface AttachSpec {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface TmuxLaunchOptions {
  cwd?: string;
  cmd?: string;
  env?: Record<string, string>;
}

export interface TmuxEnsureResult {
  created: boolean;
  error?: string;
}

export interface TmuxNewTabOptions {
  title?: string;
  cwd?: string;
  cmd?: string;
}

export interface TmuxNewTabResult {
  ok: boolean;
  error?: string;
  /** The created window's index, as tmux assigned it. */
  id?: string;
}

/** One tmux window, as `listTabs()` reports it. */
export interface TmuxTab {
  id: string;
  title: string;
  active: boolean;
}

/**
 * The driver's full surface. Consumers deliberately declare narrower shapes —
 * `SessionMux` in server/sessions.ts, `TerminalMux` in server/term.ts — so a test
 * double stands in for only what its consumer calls; this interface is what those
 * get checked against, and what gives `this` a type inside the object literal.
 */
export interface TmuxDriver {
  name: string;
  env: NodeJS.ProcessEnv;
  available(): Promise<boolean>;
  hasSession(name: string): Promise<boolean>;
  ensure(name: string, opts?: TmuxLaunchOptions): Promise<TmuxEnsureResult>;
  attachSpawn(name: string): AttachSpec;
  newTab(name: string, opts?: TmuxNewTabOptions): Promise<TmuxNewTabResult>;
  listTabs(name: string): Promise<TmuxTab[]>;
  capture(name: string, target?: string): Promise<string>;
  sendText(name: string, text: string, target?: string): Promise<RunResult>;
  paneCommand(name: string, target?: string): Promise<string>;
  selectTab(name: string, id: string | number): Promise<boolean>;
  closeTab(name: string, id: string | number): Promise<boolean>;
  renameTab(name: string, id: string | number, title: string): Promise<boolean>;
  rename(oldName: string, newName: string): Promise<boolean>;
  kill(name: string): Promise<boolean>;
}

const SOCK = 'wt-studio';
// tmux's `-c` needs a real directory. `process.env.HOME` is the spelling this has
// always used, but it is `string | undefined`; os.homedir() falls back to the passwd
// entry, so an unset HOME degrades to the user's actual home instead of handing
// execFile an undefined arg.
const HOME = process.env.HOME || os.homedir();
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

const ENV: NodeJS.ProcessEnv = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
function T(args: string[]): Promise<RunResult> { return run('tmux', ['-L', SOCK, '-f', CONF, ...args], { env: ENV }); }

// Wrap a command so the pane survives the command exiting (drops to a shell).
function persistCmd(cmd?: string): string {
  return cmd ? `${cmd}; exec ${process.env.SHELL || '/bin/bash'} -l` : `${process.env.SHELL || '/bin/bash'} -l`;
}

// Launch commands go to a FILE and we type `source <file>` — never the command itself.
//
// send-keys types into the pane's tty, and a tty in canonical mode (which is where a
// shell sits until it finishes starting and ZLE takes over the terminal in raw mode)
// silently DROPS everything past MAX_INPUT — 1024 bytes on macOS. A session launch
// command carries the user's seed and the system-prompt note inline, so it crosses
// 1024 routinely; the cut lands mid-single-quote and the shell then sits at `quote>`
// forever, waiting for a closing quote that was thrown away. claude never starts and
// nothing reports an error, because from tmux's side the keys were delivered.
// One file per pane, rewritten each launch: bounded, no cleanup, and `cat`-able when
// a launch needs debugging.
const LAUNCH_DIR = path.join(CONFIG_DIR, 'launch');
export function launchKeys(target: string, cmd?: string): string {
  const line = persistCmd(cmd);
  try {
    fs.mkdirSync(LAUNCH_DIR, { recursive: true });
    const file = path.join(LAUNCH_DIR, `${target.replace(/[^A-Za-z0-9._-]/g, '_')}.sh`);
    fs.writeFileSync(file, `${line}\n`, { mode: 0o600 });
    return `. '${file.replace(/'/g, `'\\''`)}'`; // `.`, not `source` — dash/sh don't have `source`
  } catch {
    return line; // can't write → type it, which is what we did before (and works under 1024)
  }
}

const tmux: TmuxDriver = {
  name: 'tmux',
  env: ENV,

  async available() { return (await T(['-V'])).code === 0; },

  async hasSession(name) {
    return (await T(['has-session', '-t', `=${name}`])).code === 0;
  },

  async ensure(name, { cwd, cmd, env } = {}) {
    if (await this.hasSession(name)) return { created: false };
    // Pass env in new-session itself (-e KEY=VAL, tmux ≥3.2) so window 0's shell —
    // and the claude launched into it — inherits it. set-environment AFTER new-session
    // is too late: window 0 already spawned without the vars.
    const envArgs: string[] = [];
    if (env) for (const [k, v] of Object.entries(env)) envArgs.push('-e', `${k}=${String(v)}`);
    const r = await T(['new-session', '-d', '-s', name, '-n', 'claude', '-x', '220', '-y', '50', '-c', cwd || HOME, ...envArgs]);
    if (r.code !== 0) return { created: false, error: r.stderr.trim() };
    await T(['set-option', '-t', name, 'remain-on-exit', 'off']);
    await T(['send-keys', '-t', `${name}:0`, '--', launchKeys(`${name}-0`, cmd), 'Enter']);
    return { created: true };
  },

  // For node-pty: attach an interactive client to the session.
  attachSpawn(name) {
    return { file: 'tmux', args: ['-L', SOCK, 'attach-session', '-t', name], env: ENV };
  },

  // `-P -F #{window_id}` returns tmux's STABLE window id (@7), not its index.
  //
  // The distinction is the whole bug this addresses: `renumber-windows on` means an
  // index is a POSITION, reassigned whenever any earlier window closes. Keying a tab on
  // it makes the stored title follow the slot rather than the terminal, so closing the
  // middle of [claude, api, web] relabels web as "api". A window_id never changes for
  // the life of the window, and tmux accepts it as a -t target everywhere.
  async newTab(name, { title, cwd, cmd } = {}) {
    const r = await T(['new-window', '-P', '-F', '#{window_id}', '-t', name, '-n', title || 'shell', '-c', cwd || HOME]);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
    // new-window selects the new window → send the command to the session's active window
    if (cmd) await T(['send-keys', '-t', name, '--', launchKeys(`${name}-tab`, cmd), 'Enter']);
    return { ok: true, id: r.stdout.trim() || undefined };
  },

  async renameTab(name, id, title) {
    return (await T(['rename-window', '-t', `${name}:${id}`, title])).code === 0;
  },

  async listTabs(name) {
    const r = await T(['list-windows', '-t', name, '-F', '#{window_id}\t#{window_name}\t#{window_active}']);
    if (r.code !== 0) return [];
    return r.stdout.trim().split('\n').filter(Boolean).map((l) => {
      const [wid, wname, active] = l.split('\t');
      return { id: wid, title: wname, active: active === '1' };
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
    // Still killed, and deliberately: sessions created before pop-out and the split pane
    // were removed may have one of these alive, and nothing else would ever reap them.
    await T(['kill-session', '-t', `=${name}-popout`]);
    await T(['kill-session', '-t', `=${name}-split`]);
    return true;
  },

};

export default tmux;
