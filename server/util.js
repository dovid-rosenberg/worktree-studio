'use strict';
// Small shared helpers: shell/git exec, atomic JSON, tilde expansion, ids.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

function expandTilde(p) {
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
// (see server/forge.js and server/worktree.js).
const DEFAULT_TIMEOUT_MS = 120000;

// Promise wrapper around execFile with a generous buffer. Never throws on a
// non-zero exit — returns { code, stdout, stderr, timedOut } so callers decide.
function run(cmd, args = [], opts = {}) {
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
        timedOut: !!(err && err.killed),
        error: err || null,
      });
    });
  });
}

// git in a given repo; returns trimmed stdout ('' on failure).
async function git(cwd, args) {
  const r = await run('git', ['-C', cwd, ...args]);
  return r.code === 0 ? r.stdout.trim() : '';
}

async function gitFull(cwd, args, opts = {}) {
  return run('git', ['-C', cwd, ...args], opts);
}

function has(cmd) {
  // synchronous best-effort lookup used at startup.
  const { execFileSync } = require('child_process');
  try {
    execFileSync('command', ['-v', cmd], { shell: '/bin/bash', stdio: 'ignore' });
    return true;
  } catch {
    try { execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Read a JSON *state* file, telling "not there yet" apart from "there but corrupt".
//
// readJson() returns its fallback for both, and the callers then write that
// fallback back over the file at the next save — so a truncated sessions.json
// silently becomes an empty one, taking the claudeSessionId values that tie each
// Studio session to a live tmux/claude conversation with it. Unlike config.json
// these files are not hand-edited (writeJson is atomic), so refusing to boot would
// be the wrong trade: preserve the bad file, say so, and carry on empty.
function readJsonState(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  if (!text.trim()) return fallback;
  try { return JSON.parse(text); }
  catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    let kept = false;
    try { fs.renameSync(file, aside); kept = true; } catch { /* */ }
    console.error(`[wt-studio] ${file} is not valid JSON (${e.message}). `
      + `${kept ? `Kept it at ${aside}` : 'Could not move it aside'}; continuing with empty state.`);
    return fallback;
  }
}

function writeJson(file, obj) {
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
function makeId(prefix = '') { return `${prefix}${crypto.randomUUID()}`; }

// Short, stable handle derived from an id, for the places that need a *label* rather
// than a credential — tmux session names, which have to stay inside 60-odd readable
// characters. Never use this where the full id is the thing being authenticated.
function shortId(id) { return String(id).replace(/[^0-9a-f]/gi, '').slice(-8) || 'session'; }

// Resolve a path through its symlinks, falling back to the path itself when it
// can't be resolved (doesn't exist yet, permission denied). Worktree paths are
// compared across three independent sources — the git scan, a session's stored
// paths, and lsof's view of a running process — and any of them may hand us a
// symlinked spelling (/tmp vs /private/tmp, a symlinked home), so every
// comparison goes through this first.
function realpath(p) { try { return fs.realpathSync(p); } catch { return p; } }

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
  const cache = new Map();
  let hits = 0, misses = 0;
  return {
    resolve(p) {
      if (!p) return p;
      if (cache.has(p)) { hits++; return cache.get(p); }
      misses++;
      let r;
      try { r = fs.realpathSync(p); } catch { return p; }
      cache.set(p, r);
      return r;
    },
    retain(livePaths) {
      const keep = livePaths instanceof Set ? livePaths : new Set(livePaths);
      for (const p of cache.keys()) if (!keep.has(p)) cache.delete(p);
    },
    get size() { return cache.size; },
    get stats() { return { hits, misses }; },
  };
}

// Turn any string into a safe slug usable as branch/worktree/mux-session name.
function slug(s, max = 48) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'session';
}

// POSIX single-quote a string for safe inclusion in a shell command.
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Wrap async route handlers so a rejected promise becomes a 500 instead of an
// unhandled rejection (Express 4 doesn't await handlers). Lives here so every
// route module wraps its handlers the same way.
const A = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[wt-studio]', e);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

module.exports = { HOME, expandTilde, run, git, gitFull, has, readJson, readJsonState, writeJson, makeId, shortId, realpath, createRealpathCache, slug, shq, A, DEFAULT_TIMEOUT_MS };
