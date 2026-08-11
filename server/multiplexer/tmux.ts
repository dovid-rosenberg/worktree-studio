// tmux driver for the multiplexer interface. Rock-solid, scriptable, clean 1:1
// tab indexing, and a grouped-session pop-out that doesn't orphan the embedded
// client. Runs on a dedicated socket with a chrome-free config (no status bar,
// no borders) so the embedded terminal reads native.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CHILD_ENV, run } from '../util.ts';
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
  /** The agent window's stable id, when this call created it. */
  id?: string;
}

/** What `relaunchAgent` did, and where the agent now lives. */
export interface TmuxRelaunchResult {
  ok: boolean;
  error?: string;
  /** The agent window's stable id — reused or freshly opened. */
  id?: string;
  /** False when the old window could not be reused and a new one was opened. */
  reused?: boolean;
  /** The agent was already running there — nothing was launched. */
  running?: boolean;
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
  relaunchAgent(
    name: string,
    opts: TmuxLaunchOptions & { tabId?: string | null },
  ): Promise<TmuxRelaunchResult>;
  attachSpawn(name: string): AttachSpec;
  newTab(name: string, opts?: TmuxNewTabOptions): Promise<TmuxNewTabResult>;
  listTabs(name: string): Promise<TmuxTab[]>;
  capture(name: string, target?: string): Promise<string>;
  sendText(name: string, text: string, target?: string): Promise<RunResult>;
  paneCommand(name: string, target?: string): Promise<string>;
  paneCwd(name: string, target?: string): Promise<string>;
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
    fs.writeFileSync(
      CONF,
      [
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
      ].join('\n'),
    );
  } catch {
    /* */
  }
})();

const ENV: NodeJS.ProcessEnv = CHILD_ENV;
function T(args: string[]): Promise<RunResult> {
  return run('tmux', ['-L', SOCK, '-f', CONF, ...args], { env: ENV });
}

// Wrap a command so the pane survives the command exiting (drops to a shell).
function persistCmd(cmd?: string): string {
  return cmd
    ? `${cmd}; exec ${process.env.SHELL || '/bin/bash'} -l`
    : `${process.env.SHELL || '/bin/bash'} -l`;
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
// One file per pane, rewritten each launch, and `cat`-able when a launch needs debugging.
//
// This was "bounded, no cleanup", which was only half true: bounded PER PANE, but a pane
// name carries a session id, and ids die. 85 files had accumulated, most of them for
// features finished weeks earlier. reapLaunchScripts() below is the missing half.
const LAUNCH_DIR = path.join(CONFIG_DIR, 'launch');

/**
 * Delete launch scripts older than `maxAgeMs` (default 24h). Called once at boot.
 *
 * Age is the right key, not liveness: the file is `.`-sourced ONCE, by the shell tmux
 * just started, and is dead weight from that moment on. So an old file cannot be in use
 * by definition, and a session that is later resumed writes a fresh one. The window only
 * needs to outlive a launch, and a launch is measured in seconds.
 *
 * Returns how many it removed, for the boot log.
 */
export function reapLaunchScripts(maxAgeMs = 24 * 60 * 60 * 1000): number {
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  let names: string[];
  try {
    names = fs.readdirSync(LAUNCH_DIR);
  } catch {
    return 0;
  } // never created yet
  for (const name of names) {
    if (!name.endsWith('.sh')) continue;
    const file = path.join(LAUNCH_DIR, name);
    try {
      if (fs.statSync(file).mtimeMs >= cutoff) continue;
      fs.unlinkSync(file);
      removed++;
    } catch {
      /* raced with something else, or unreadable — leave it */
    }
  }
  return removed;
}
/*
 * Env that stops the pane's rc files from ASKING THE USER something at startup.
 *
 * The launch command is typed into the pane's tty (see launchKeys), so it is sitting in
 * the tty buffer while the shell is still starting. Anything in the user's rc that reads
 * stdin during startup eats it. oh-my-zsh's periodic update check is the one that bites:
 *
 *   . '/…/launch/wts-x-0.sh'                     <- what we typed
 *   [oh-my-zsh] Would you like to update? [Y/n]  <- reads the tty
 *    '/…/launch/wts-x-0.sh'                      <- the leftover after ". " was consumed
 *   zsh: permission denied: /…/launch/wts-x-0.sh <- zsh EXECUTES it; mode is 0600
 *
 * and the session comes up with no agent in it. Reproduced 12/12 on a machine whose
 * oh-my-zsh had decided it was time to check.
 *
 * These only apply inside Studio's own panes — nothing here changes the user's shell
 * anywhere else. It is a mitigation of the common case, not a cure: the general problem
 * is that a startup prompt and a typed command share one tty. See the comment on
 * launchKeys for why the command is typed at all.
 */
const STARTUP_QUIET: Record<string, string> = {
  DISABLE_AUTO_UPDATE: 'true', // oh-my-zsh: do not offer to update
  DISABLE_UPDATE_PROMPT: 'true', // oh-my-zsh: and do not ask if it decides to anyway
  ZSH_DISABLE_COMPFIX: 'true', // zsh: "insecure directories" prompt on some setups
};

/*
 * Names that mean "this pane is a shell sitting at a prompt", not a program worth keeping.
 *
 * The fallback half of isIdleShell — see there for why $SHELL is the primary authority.
 * A login shell announces itself with a leading `-` in argv[0] and tmux reports that
 * verbatim, so callers strip it before testing.
 */
const KNOWN_SHELLS = /^(sh|bash|zsh|ksh|mksh|csh|tcsh|dash|ash|fish|nu|xonsh|elvish|pwsh|login)$/;

/**
 * Is the pane's foreground program just a shell, i.e. did whatever we launched exit?
 *
 * Resume hangs off this: a shell means the agent is gone and we relaunch into the pane,
 * anything else means SOMETHING is alive there and we adopt it rather than start a second
 * claude on the same conversation. Getting it wrong in the "shell" direction duplicates an
 * agent; getting it wrong in the other direction is silent and permanent, which is the one
 * that shipped.
 *
 * It was a regex of POSIX shell names — `/^(-?(z|ba|k|c|tc|da)?sh|login)$/`. But the shell
 * a pane drops to is `$SHELL` (persistCmd execs it), and a fish or nushell user's idle pane
 * therefore reports `fish`. That is not in the list, so it read as "an agent is running":
 * the session was marked adopted, nothing was launched, and Resume returned success. The
 * button did nothing, every time, and said it had worked.
 *
 * So ask $SHELL first — it is literally the process we put there — and keep a name list for
 * the panes we did not start that way (a session tmux already had, a shell exec'd by an
 * rc file) and for an environment with no $SHELL at all.
 */
export function isIdleShell(cmd: string, shell = process.env.SHELL || ''): boolean {
  const base = cmd.trim().replace(/^-/, '');
  if (!base) return false;
  return base === path.basename(shell) || KNOWN_SHELLS.test(base);
}

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

/**
 * Wait until a freshly-created pane's shell is actually ready to be typed into.
 *
 * send-keys writes to the pane's tty, and a shell that has not finished starting has not
 * taken the terminal over yet — so the keys sit in the tty buffer and are at the mercy of
 * whatever the rc files do next. Two ways that goes wrong, both observed on one machine:
 *
 *   * something in the rc reads stdin (oh-my-zsh's update prompt) and EATS the command —
 *     see STARTUP_QUIET, which handles the common case but cannot handle all of them;
 *   * ZLE initialises mid-buffer and keeps only part of the line, so the Enter we sent
 *     submits a truncated path: `. '/Users/davidr/.config/worktre` and nothing runs.
 *
 * The second one failed 5 times in 12 on a shell with a heavy rc. There is no "shell is
 * ready" event to wait on, so this waits for the pane to STOP CHANGING: a shell that has
 * finished starting has drawn its prompt and then produces nothing until it is typed at.
 * Two identical, non-empty samples is that condition.
 *
 * Bounded, and a timeout is not fatal: typing into a slow shell is what happened before
 * this existed, so the worst case is the behaviour we already had.
 */
async function waitForPaneReady(name: string, target: string, timeoutMs = 6000): Promise<boolean> {
  const started = Date.now();
  let previous: string | null = null;
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 150));
    const r = await T(['capture-pane', '-t', `${name}:${target}`, '-p']);
    if (r.code !== 0) return false; // pane went away — nothing to type into
    const now = r.stdout.trimEnd();
    // Non-empty: an empty pane means the shell has not printed a prompt yet, and two
    // empty samples in a row would otherwise read as "settled" on a fast machine.
    if (now && previous !== null && now === previous) return true;
    previous = now;
  }
  return false;
}

const tmux: TmuxDriver = {
  name: 'tmux',
  env: ENV,

  async available() {
    return (await T(['-V'])).code === 0;
  },

  async hasSession(name) {
    return (await T(['has-session', '-t', `=${name}`])).code === 0;
  },

  async ensure(name, { cwd, cmd, env } = {}) {
    if (await this.hasSession(name)) return { created: false };
    // Pass env in new-session itself (-e KEY=VAL, tmux ≥3.2) so window 0's shell —
    // and the claude launched into it — inherits it. set-environment AFTER new-session
    // is too late: window 0 already spawned without the vars.
    const envArgs: string[] = [];
    // STARTUP_QUIET first, so a caller-supplied value of the same name still wins.
    for (const [k, v] of Object.entries({ ...STARTUP_QUIET, ...(env || {}) })) {
      envArgs.push('-e', `${k}=${String(v)}`);
    }
    // `-P -F #{window_id}` so the caller learns the agent window's STABLE id here, at
    // the one moment it is unambiguous. Learning it later — "the only window there is"
    // — works exactly once: recreate the session and the id changes while the stored
    // one does not, and every check against it then reports an agent that has exited.
    const r = await T([
      'new-session',
      '-d',
      '-P',
      '-F',
      '#{window_id}',
      '-s',
      name,
      '-n',
      'claude',
      '-x',
      '220',
      '-y',
      '50',
      '-c',
      cwd || HOME,
      ...envArgs,
    ]);
    if (r.code !== 0) return { created: false, error: r.stderr.trim() };
    await T(['set-option', '-t', name, 'remain-on-exit', 'off']);
    // Never type into a shell that has not finished starting — see waitForPaneReady.
    await waitForPaneReady(name, '0');
    await T(['send-keys', '-t', `${name}:0`, '--', launchKeys(`${name}-0`, cmd), 'Enter']);
    return { created: true, id: r.stdout.trim() || undefined };
  },

  /*
   * Start the agent again inside a session that already exists.
   *
   * `ensure` is create-if-missing, so it has nothing to say about a session whose
   * tmux is alive but whose claude has exited — which is what a session looks like
   * after the agent quits and the launch script's `exec zsh -l` takes the pane. Resume
   * went through ensure alone, saw "session exists", and relaunched nothing.
   *
   * What the agent's pane is running decides between the three outcomes:
   *
   * - a plain shell → the agent exited and left its login shell; relaunch there.
   * - anything else → SOMETHING is alive in the agent's window. Adopt it rather than
   *   launch: a live claude reports its Bash tool as the pane command, so "not a
   *   shell" cannot be told from "busy agent", and guessing wrong the other way puts
   *   a second claude in the same session, both resuming the same conversation.
   * - no agent window at all → open one.
   *
   * Adopting is also the whole repair for a session that was ALREADY running and only
   * looked dead because its recorded window id was stale: the caller gets the live id
   * back and the state stops lying, without touching the agent.
   */
  async relaunchAgent(name, { cwd, cmd, tabId } = {}) {
    const tabs = await this.listTabs(name);
    if (!tabs.length) return { ok: false, error: 'session has no windows' };
    const target = tabs.find((t) => t.id === tabId) || tabs.find((t) => t.title === 'claude');
    if (target) {
      const running = (await this.paneCommand(name, target.id)).trim();
      if (running && !isIdleShell(running)) {
        return { ok: true, id: target.id, reused: true, running: true };
      }
      /*
       * The third send-keys site, and the one that needed this most.
       *
       * The pane we are typing into is a login shell that took over when claude exited,
       * and it may have been sitting there for hours — or it may have started a moment
       * ago, mid-`.zshrc`, which is exactly the state that swallows the front of the
       * line. Resume is the common path to this code, so an unguarded send here is the
       * original bug reachable by the route people actually take.
       *
       * A shell that has been idle for hours answers on the first poll, so the guard
       * costs a single capture-pane in the case that does not need it.
       */
      await waitForPaneReady(name, target.id);
      const sent = await T([
        'send-keys',
        '-t',
        `${name}:${target.id}`,
        '--',
        launchKeys(`${name}-${target.id}`, cmd),
        'Enter',
      ]);
      if (sent.code !== 0) return { ok: false, error: sent.stderr.trim() };
      return { ok: true, id: target.id, reused: true };
    }
    const opened = await this.newTab(name, { title: 'claude', cwd, cmd });
    if (!opened.ok) return { ok: false, error: opened.error };
    return { ok: true, id: opened.id, reused: false };
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
    const r = await T([
      'new-window',
      '-P',
      '-F',
      '#{window_id}',
      '-t',
      name,
      '-n',
      title || 'shell',
      '-c',
      cwd || HOME,
    ]);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
    const wid = r.stdout.trim();
    if (cmd) {
      /*
       * Address the window we just made BY ID, both here and in the wait.
       *
       * This used to send to `-t name` — the SESSION, which tmux resolves to whatever
       * window is active AT THAT MOMENT — on the reasoning that new-window had just
       * selected ours. True when the line was written, false by the time it runs: the
       * wait below can sit here for up to six seconds, and a click on another tab or a
       * second newTab landing in the same session moves the active window underneath us.
       * The launch command was then typed into whatever pane won, and the pane that
       * usually wins is the agent's: a shell command submitted into a live conversation.
       *
       * Same hazard as ensure(): a brand-new window's shell is mid-startup.
       */
      await waitForPaneReady(name, wid);
      // The script is named per WINDOW, not per session. `${name}-tab` meant two tabs
      // opening at once in one session wrote the same file, and the first one to reach
      // send-keys sourced the second one's command.
      await T(['send-keys', '-t', `${name}:${wid}`, '--', launchKeys(`${name}-${wid}`, cmd), 'Enter']);
    }
    return { ok: true, id: wid || undefined };
  },

  async renameTab(name, id, title) {
    return (await T(['rename-window', '-t', `${name}:${id}`, title])).code === 0;
  },

  async listTabs(name) {
    const r = await T(['list-windows', '-t', name, '-F', '#{window_id}\t#{window_name}\t#{window_active}']);
    if (r.code !== 0) return [];
    return r.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
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

  // Where the pane actually IS. tmux tracks this per pane, so it follows a `cd` the
  // agent did on its own — which is how a session that made itself a worktree and
  // moved into it gets noticed (see SessionManager._adoptWanderedWorktree).
  async paneCwd(name, target = '0') {
    const r = await T(['display-message', '-p', '-t', `${name}:${target}`, '#{pane_current_path}']);
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

  /*
   * Returns whether the session is actually GONE, which is not what it used to return.
   *
   * It discarded kill-session's exit code and answered `true` unconditionally, so a tmux
   * that could not be reached at all still read as a clean kill. deactivate() then marked
   * the session stopped and reported success — and a stopped session is exactly the one
   * reconcile skips, so the agent kept running, and burning tokens, with nothing left
   * watching it and no way for the user to learn that.
   *
   * "Already gone" is a success, not a failure: kill-session exits non-zero on a session
   * it cannot find, and deactivating a session whose tmux died on its own is the ordinary
   * case. So the answer is the state, not the exit code — and when tmux is unreachable
   * has-session cannot confirm anything either, which is the `false` the caller needs.
   */
  async kill(name) {
    const killed = await T(['kill-session', '-t', `=${name}`]);
    // Still killed, and deliberately: sessions created before pop-out and the split pane
    // were removed may have one of these alive, and nothing else would ever reap them.
    // Their fate does not decide the answer — the session proper does.
    await T(['kill-session', '-t', `=${name}-popout`]);
    await T(['kill-session', '-t', `=${name}-split`]);
    return killed.code === 0 || !(await this.hasSession(name));
  },
};

export default tmux;
