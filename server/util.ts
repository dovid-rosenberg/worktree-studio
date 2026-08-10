// Small shared helpers: shell/git exec, atomic JSON, tilde expansion, ids.
import { execFile, execFileSync } from 'child_process';
import type { ExecFileException, ExecFileOptions } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOME = os.homedir();

function expandTilde(p: string): string {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

// Backstop ceiling on any child process. Nothing this app shells out to is meant
// to take two minutes, and a call that does has not "gone slow" — it has hung: a
// credential helper prompting on a stdin nobody is ever going to answer, a fetch
// over a VPN that dropped mid-handshake. With no ceiling the promise never
// settles, so the route never responds AND the child is never reaped.
//
// It has to be execFile's own `timeout`, which KILLS the child; a promise-level
// race would resolve the caller and leave the process wedged forever. This is the
// last line of defence — the network-bound callers set their own, tighter, bound
// (see server/forge.ts and server/worktree.ts).
const DEFAULT_TIMEOUT_MS = 120000;

/** What every shell-out in the app hands back. Non-zero exit is data, not an error. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Killed by the timeout — the one failure a user can act on, and otherwise indistinguishable. */
  timedOut: boolean;
  error: ExecFileException | null;
}

export type RunOptions = ExecFileOptions & { timeout?: number };

// Promise wrapper around execFile with a generous buffer. Never throws on a
// non-zero exit — returns { code, stdout, stderr, timedOut } so callers decide.
function run(cmd: string, args: string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  const { timeout = DEFAULT_TIMEOUT_MS, ...rest } = opts;
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout, ...rest }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        // A child killed on the timeout exits with no code and usually no stderr at
        // all, so without this flag "hung and killed" is indistinguishable from any
        // other failure — and it is the one failure the user can actually act on.
        timedOut: !!err?.killed,
        error: err || null,
      });
    });
  });
}

// git in a given repo; returns trimmed stdout ('' on failure).
async function git(cwd: string, args: string[]): Promise<string> {
  const r = await run('git', ['-C', cwd, ...args]);
  return r.code === 0 ? r.stdout.trim() : '';
}

async function gitFull(cwd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run('git', ['-C', cwd, ...args], opts);
}

/**
 * The environment every child process gets, Homebrew first.
 *
 * A GUI-launched daemon (launchd, an app bundle) inherits a minimal PATH that does not
 * include `/opt/homebrew/bin` or `/usr/local/bin`, so `gh`, `glab` and `tmux` are simply
 * not there. This prelude was copy-pasted into six modules — servers, runner, forge, tmux
 * and both source adapters — and `has()` below did NOT use it, so Studio probed for a CLI
 * under one PATH and then ran it under another. On a launchd start that reports a tool
 * missing which is about to work fine, or present when the probe got lucky.
 */
const CHILD_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
};

function has(cmd: string): boolean {
  // Synchronous best-effort lookup used at startup — under CHILD_ENV, so it answers the
  // question the caller is actually asking: "will this work when I run it?"
  try {
    execFileSync('command', ['-v', cmd], { shell: '/bin/bash', stdio: 'ignore', env: CHILD_ENV });
    return true;
  } catch {
    try {
      execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore', env: CHILD_ENV });
      return true;
    } catch {
      return false;
    }
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

// Read a JSON *state* file, telling "not there yet" apart from "there but corrupt".
//
// readJson() returns its fallback for both, and the callers then write that
// fallback back over the file at the next save — so a truncated sessions.json
// silently becomes an empty one, taking the claudeSessionId values that tie each
// Studio session to a live tmux/claude conversation with it. Unlike config.json
// these files are not hand-edited (writeJson is atomic), so refusing to boot would
// be the wrong trade: preserve the bad file, say so, and carry on empty.
function readJsonState<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    let kept = false;
    try {
      fs.renameSync(file, aside);
      kept = true;
    } catch {
      /* */
    }
    console.error(
      `[wt-studio] ${file} is not valid JSON (${(e as Error).message}). ` +
        `${kept ? `Kept it at ${aside}` : 'Could not move it aside'}; continuing with empty state.`,
    );
    return fallback;
  }
}

function writeJson(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// A session id is a credential, not a sequence number: `/ws/term?session=<id>`
// hands out a read/write PTY into that session's tmux, so an id that can be guessed
// or enumerated is a remote shell. The old scheme (a microsecond clock reading plus
// a counter) was both. randomUUID is 122 CSPRNG bits.
// Ids are only ever compared for equality and used as map keys — nothing validates
// their shape — so ids minted by the old scheme keep working unchanged.
function makeId(prefix = ''): string {
  return `${prefix}${crypto.randomUUID()}`;
}

// Short, stable handle derived from an id, for the places that need a *label* rather
// than a credential — tmux session names, which have to stay inside 60-odd readable
// characters. Never use this where the full id is the thing being authenticated.
function shortId(id: string): string {
  return (
    String(id)
      .replace(/[^0-9a-f]/gi, '')
      .slice(-8) || 'session'
  );
}

// Resolve a path through its symlinks, falling back to the path itself when it
// can't be resolved (doesn't exist yet, permission denied). Worktree paths are
// compared across three independent sources — the git scan, a session's stored
// paths, and lsof's view of a running process — and any of them may hand us a
// symlinked spelling (/tmp vs /private/tmp, a symlinked home), so every
// comparison goes through this first.
function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// A memo for realpath(), because resolving a path costs a syscall per path
// component and the state build resolves the same few dozen worktree paths many
// times a second.
//
// Two rules keep it from going stale, and neither is a clock:
//   - A failure is never cached. An unresolvable path is one that doesn't exist
//     *yet*; caching the fallback would pin it even after it appears.
//   - `retain(livePaths)` drops every entry whose path is not in the caller's
//     current list of real paths. A resolved path cannot change while the path
//     keeps existing (it is pure symlink resolution over the components), so the
//     only way to go stale is removal followed by recreation somewhere else —
//     and the caller that knows about removals is the one holding the live list.
// Deliberately NOT usage-based: an entry retained merely because something asked
// for it recently is exactly the entry that survives a removal.
function createRealpathCache() {
  const cache = new Map<string, string>();
  let hits = 0,
    misses = 0;
  return {
    resolve(p: string): string {
      if (!p) return p;
      // `has` first, not `get() ?? miss`: the map never stores a nullish value, so
      // this is the only form that stays correct if one is ever added.
      const hit = cache.get(p);
      if (hit !== undefined) {
        hits++;
        return hit;
      }
      misses++;
      let r: string;
      try {
        r = fs.realpathSync(p);
      } catch {
        return p;
      }
      cache.set(p, r);
      return r;
    },
    retain(livePaths: Iterable<string>): void {
      const keep = livePaths instanceof Set ? livePaths : new Set(livePaths);
      for (const p of cache.keys()) if (!keep.has(p)) cache.delete(p);
    },
    get size() {
      return cache.size;
    },
    get stats() {
      return { hits, misses };
    },
  };
}

// Turn any string into a safe slug usable as branch/worktree/mux-session name.
function slug(s: string | null | undefined, max = 48): string {
  return (
    (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'session'
  );
}

// POSIX single-quote a string for safe inclusion in a shell command.
function shq(s: unknown): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// There used to be an `A(fn, tag)` wrapper here that every route handler was passed
// through, because express@4 does not await a handler — a rejected promise became an
// unhandled rejection rather than a 500, and since server/crash.ts makes those fatal,
// one handler somebody forgot to wrap would kill the daemon. express@5 forwards a
// rejection to the error middleware itself, so the wrapper is gone and the policy it
// enforced lives in exactly one place: crash.routeErrors(), mounted last in server.ts.

export {
  CHILD_ENV,
  HOME,
  expandTilde,
  run,
  git,
  gitFull,
  has,
  readJson,
  readJsonState,
  writeJson,
  makeId,
  shortId,
  realpath,
  createRealpathCache,
  slug,
  shq,
  DEFAULT_TIMEOUT_MS,
};

/**
 * Run an editor's open command and say whether it worked.
 *
 * Both open routes discarded `run()`'s exit code and answered a hardcoded `{ok: true}`,
 * so a misconfigured `editors.<name>.open` — a renamed binary, an editor CLI that was
 * never installed onto PATH — reported success and opened nothing. The user's only clue
 * was that no window appeared, which is also what a slow editor looks like.
 */
export async function openEditor(cmds: string[]): Promise<{ ok: boolean; error?: string }> {
  const failures: string[] = [];
  for (const c of cmds) {
    const r = await run('bash', ['-lc', c]);
    if (r.code !== 0)
      failures.push(
        String(r.stderr || '')
          .trim()
          .split('\n')[0] || `exit ${r.code}`,
      );
  }
  return failures.length ? { ok: false, error: failures[0] } : { ok: true };
}
