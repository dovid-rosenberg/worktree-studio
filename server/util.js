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

module.exports = { HOME, expandTilde, run, git, gitFull, has, readJson, writeJson, makeId, slug, shq };
