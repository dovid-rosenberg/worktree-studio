'use strict';
// Small shared helpers: shell/git exec, atomic JSON, tilde expansion, ids.
const { execFile } = require('child_process');
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

// Promise wrapper around execFile with a generous buffer. Never throws on a
// non-zero exit — returns { code, stdout, stderr } so callers decide.
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
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

async function gitFull(cwd, args) {
  return run('git', ['-C', cwd, ...args]);
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

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

let _n = 0;
function makeId(prefix = '') {
  _n = (_n + 1) % 1e6;
  const s = Math.floor(process.hrtime()[1] / 1000).toString(36) + _n.toString(36);
  return prefix ? `${prefix}${s}` : s;
}

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

module.exports = { HOME, expandTilde, run, git, gitFull, has, readJson, writeJson, makeId, realpath, createRealpathCache, slug, shq, A };
