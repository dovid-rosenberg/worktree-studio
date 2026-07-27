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

module.exports = { HOME, expandTilde, run, git, gitFull, has, readJson, writeJson, makeId, shortId, slug, shq, A };
