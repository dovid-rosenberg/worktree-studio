'use strict';
// Native replacement for the `wt` script — baked in so the app owns worktree
// creation end to end. Creates .worktrees/<name> off the repo's default branch
// and copies in the gitignored bits a plain `git worktree add` drops:
// WebStorm run configs (.idea/runConfigurations/*.xml) + local config/.env files.
const fs = require('fs');
const path = require('path');
const { git, gitFull, slug } = require('./util');

// Expand a shell-style pattern (e.g. "config/*-config.js", ".env.*.local")
// relative to base. Supports `*` (any chars within one path segment). Segments
// are matched literally when they contain no `*`.
function expandPattern(base, pattern) {
  const segs = pattern.split('/');
  let dirs = [''];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    const next = [];
    const re = seg.includes('*')
      ? new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')
      : null;
    for (const d of dirs) {
      const abs = path.join(base, d);
      if (re) {
        let entries;
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (!re.test(e.name)) continue;
          if (last ? e.isFile() : e.isDirectory()) next.push(path.join(d, e.name));
        }
      } else {
        const cand = path.join(abs, seg);
        try {
          const st = fs.statSync(cand);
          if (last ? st.isFile() : st.isDirectory()) next.push(path.join(d, seg));
        } catch { /* missing */ }
      }
    }
    dirs = next;
  }
  return dirs;
}

async function isIgnored(repoPath, rel) {
  const r = await gitFull(repoPath, ['check-ignore', '-q', rel]);
  return r.code === 0;
}

async function populate(repoPath, dest, patterns) {
  const copied = { runConfigs: 0, files: 0 };
  // run configs — copied unconditionally (they're gitignored by convention)
  const rcDir = path.join(repoPath, '.idea', 'runConfigurations');
  if (fs.existsSync(rcDir)) {
    const destRc = path.join(dest, '.idea', 'runConfigurations');
    fs.mkdirSync(destRc, { recursive: true });
    for (const f of fs.readdirSync(rcDir)) {
      if (!f.endsWith('.xml')) continue;
      try { fs.copyFileSync(path.join(rcDir, f), path.join(destRc, f)); copied.runConfigs++; } catch { /* */ }
    }
  }
  // local files — only carry the ones git actually ignores
  for (const pat of patterns || []) {
    for (const rel of expandPattern(repoPath, pat)) {
      const src = path.join(repoPath, rel);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
      if (!(await isIgnored(repoPath, rel))) continue; // tracked files arrive with checkout
      const target = path.join(dest, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try { fs.copyFileSync(src, target); copied.files++; } catch { /* */ }
    }
  }
  return copied;
}

// Does a local or remote branch already exist?
async function branchExists(repoPath, branch) {
  const local = await gitFull(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (local.code === 0) return true;
  const remote = await gitFull(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  return remote.code === 0;
}

async function defaultBase(repoPath) {
  const sym = await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (sym) return sym; // e.g. origin/develop
  const cur = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return cur || 'main';
}

/**
 * Create a worktree. Returns { ok, path, branch, name, base, created, copied, warnings, error }.
 * @param {string} branch  branch name (created off default base if it doesn't exist)
 * @param {string} name    worktree dir name under .worktrees (defaults from branch)
 */
async function create(repoPath, branch, name, opts = {}) {
  const warnings = [];
  let wtName = slug(name || branch.replace(/\//g, '-'));
  let dest = path.join(repoPath, '.worktrees', wtName);

  // On a name/branch collision: opts.unique auto-suffixes (foo → foo-2) instead
  // of hard-failing, keeping the worktree name and branch's last segment in sync.
  if (opts.unique) {
    const baseName = wtName;
    let n = 1;
    // eslint-disable-next-line no-await-in-loop
    while (fs.existsSync(dest) || (await branchExists(repoPath, branch))) {
      n += 1;
      wtName = `${baseName}-${n}`;
      dest = path.join(repoPath, '.worktrees', wtName);
      branch = branch.replace(/[^/]+$/, wtName);
    }
    if (n > 1) warnings.push(`name was taken — using "${wtName}"`);
  }

  if (fs.existsSync(dest)) {
    return { ok: false, error: `worktree "${wtName}" already exists in ${path.basename(repoPath)}`, path: dest, name: wtName, branch };
  }
  // warn if .worktrees isn't ignored (checkouts would show as untracked)
  const ign = await gitFull(repoPath, ['check-ignore', '-q', '.worktrees']);
  if (ign.code !== 0) warnings.push('.worktrees/ is not gitignored here; checkouts will show as untracked');

  if (opts.fetch !== false) await gitFull(repoPath, ['fetch', '--prune', 'origin']);

  let created = false;
  let base = null;
  if (await branchExists(repoPath, branch)) {
    const r = await gitFull(repoPath, ['worktree', 'add', dest, branch]);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() || 'git worktree add failed', path: dest, name: wtName, branch };
  } else {
    base = await defaultBase(repoPath);
    const r = await gitFull(repoPath, ['worktree', 'add', '-b', branch, dest, base]);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() || 'git worktree add -b failed', path: dest, name: wtName, branch };
    created = true;
  }

  const copied = await populate(repoPath, dest, opts.copyPatterns);
  return { ok: true, path: dest, branch, name: wtName, base, created, copied, warnings };
}

async function remove(repoPath, worktreePath, opts = {}) {
  const r = await gitFull(repoPath, ['worktree', 'remove', worktreePath]);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || 'worktree remove failed (use force?)' };
  let branchDeleted = false;
  if (opts.deleteBranch && opts.branch) {
    const d = await gitFull(repoPath, ['branch', '-d', opts.branch]);
    branchDeleted = d.code === 0;
  }
  return { ok: true, branchDeleted };
}

module.exports = { create, remove, populate, branchExists, defaultBase };
