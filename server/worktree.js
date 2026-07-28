'use strict';
// Native replacement for the `wt` script — baked in so the app owns worktree
// creation end to end. Creates the worktree off the repo's default branch at
// whatever path server/layout.js says (default `<repo>/.worktrees/<name>`) and
// copies in the bits a plain `git worktree add` drops: editor scratch files
// (`copyAlways`, e.g. JetBrains run configs) plus the gitignored local config
// and .env files (`copyPatterns`).
const fs = require('fs');
const path = require('path');
const { git, gitFull, slug } = require('./util');
const layoutMod = require('./layout');

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

// The editor scratch a bare `git worktree add` silently drops. Kept here (and
// re-exported through config.defaults().copyAlways) so a caller that passes no
// `copyAlways` — every pre-existing one — still gets the historical behavior.
// An explicit empty array turns it off.
const DEFAULT_COPY_ALWAYS = ['.idea/runConfigurations/*.xml'];

// The copy options `create()` wants, read out of a loaded config: a per-repo
// override under `copyPatterns`/`copyAlways` wins over `.default`. An absent
// `copyAlways` key (a config written before it existed, or a hand-built test cfg)
// keeps the historical unconditional run-config copy; an explicit one is obeyed,
// empty array included.
function worktreeCopyOpts(cfg, repo) {
  const pick = (m) => (m && (m[repo] || m.default)) || [];
  return {
    copyPatterns: pick(cfg && cfg.copyPatterns),
    copyAlways: cfg && cfg.copyAlways ? pick(cfg.copyAlways) : DEFAULT_COPY_ALWAYS,
  };
}

// Copy one expanded pattern's files from repoPath into dest. Returns the count.
function copyMatches(repoPath, dest, pattern) {
  let n = 0;
  for (const rel of expandPattern(repoPath, pattern)) {
    const src = path.join(repoPath, rel);
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.copyFileSync(src, target); n++; } catch { /* */ }
  }
  return n;
}

// `always` are patterns copied whether or not git ignores them — editor scratch
// (JetBrains run configs by default) that a checkout will not bring along.
// `patterns` are copied ONLY when git ignores them: a tracked file already
// arrives with the checkout, and copying the main checkout's copy over it would
// silently import uncommitted edits.
async function populate(repoPath, dest, patterns, always = DEFAULT_COPY_ALWAYS) {
  const copied = { runConfigs: 0, files: 0 };
  for (const pat of always || []) copied.runConfigs += copyMatches(repoPath, dest, pat);
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
 * @param {string} name    worktree dir name (defaults from branch)
 * @param {object} opts    { unique, fetch, copyPatterns, copyAlways, layout }
 *                         layout: a server/layout.js descriptor; defaults to nested `.worktrees`
 */
async function create(repoPath, branch, name, opts = {}) {
  const warnings = [];
  const layout = opts.layout || layoutMod.resolve({});
  let wtName = slug(name || branch.replace(/\//g, '-'));
  let dest = layoutMod.destFor(layout, repoPath, wtName);

  // On a name/branch collision: opts.unique auto-suffixes (foo → foo-2) instead
  // of hard-failing, keeping the worktree name and branch's last segment in sync.
  if (opts.unique) {
    const baseName = wtName;
    let n = 1;
    // eslint-disable-next-line no-await-in-loop
    while (fs.existsSync(dest) || (await branchExists(repoPath, branch))) {
      n += 1;
      wtName = `${baseName}-${n}`;
      dest = layoutMod.destFor(layout, repoPath, wtName);
      branch = branch.replace(/[^/]+$/, wtName);
    }
    if (n > 1) warnings.push(`name was taken — using "${wtName}"`);
  }

  if (fs.existsSync(dest)) {
    return { ok: false, error: `worktree "${wtName}" already exists in ${path.basename(repoPath)}`, path: dest, name: wtName, branch };
  }
  // Only a layout that puts worktrees INSIDE the repo needs ignoring; sibling and
  // external checkouts are outside the working tree and git never sees them.
  const ignoreRel = layoutMod.ignorePath(layout);
  if (ignoreRel) {
    const ign = await gitFull(repoPath, ['check-ignore', '-q', ignoreRel]);
    if (ign.code !== 0) warnings.push(`${ignoreRel}/ is not gitignored here; checkouts will show as untracked`);
  }
  // git worktree add creates the leaf, not the tree above it (sibling/external
  // layouts point outside the repo, where nothing has made the parent yet).
  fs.mkdirSync(path.dirname(dest), { recursive: true });

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

  const copied = await populate(repoPath, dest, opts.copyPatterns, opts.copyAlways);
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

module.exports = {
  create, remove, populate, branchExists, defaultBase,
  expandPattern, worktreeCopyOpts, DEFAULT_COPY_ALWAYS,
};
