'use strict';
// Discover git repos under the configured base dirs, and describe each repo's
// worktrees (branch, head, merged-into-default).
const fs = require('fs');
const path = require('path');
const { git, gitFull } = require('./util');

// Walk baseDirs up to `depth` looking for directories that contain a .git.
function findRepos(baseDirs, depth) {
  const repos = [];
  const seen = new Set();
  function walk(dir, d) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (fs.existsSync(path.join(dir, '.git'))) {
      const real = fs.realpathSync(dir);
      if (!seen.has(real)) { seen.add(real); repos.push(dir); }
      return; // don't descend into a repo (its .worktrees handled via git)
    }
    if (d <= 0) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), d - 1);
    }
  }
  for (const base of baseDirs) walk(base, depth);
  return repos;
}

function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false };
    } else if (line.startsWith('HEAD ')) {
      if (cur) cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      if (cur) cur.branch = line.slice(7).replace('refs/heads/', '');
    } else if (line === 'detached') {
      if (cur) cur.detached = true;
    } else if (line === 'bare') {
      if (cur) cur.bare = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function defaultBranch(repoPath) {
  const sym = await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (sym) return sym.replace(/^origin\//, '');
  const cur = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return cur || 'main';
}

async function describeRepo(repoPath) {
  const name = path.basename(repoPath);
  const def = await defaultBranch(repoPath);
  const defHead = await git(repoPath, ['rev-parse', `refs/heads/${def}`]) ||
    await git(repoPath, ['rev-parse', `origin/${def}`]) || '';
  const porcelain = await git(repoPath, ['worktree', 'list', '--porcelain']);
  const worktrees = parseWorktrees(porcelain);

  for (let i = 0; i < worktrees.length; i++) {
    const w = worktrees[i];
    w.isMain = i === 0;
    w.name = path.basename(w.path);
    w.merged = false;
    w.ahead = 0;
    if (!w.isMain && w.head && defHead && !w.detached) {
      const anc = await gitFull(repoPath, ['merge-base', '--is-ancestor', w.head, defHead]);
      w.merged = anc.code === 0;
    }
  }
  return { name, path: repoPath, defaultBranch: def, defaultHead: defHead, worktrees };
}

async function scan(baseDirs, depth) {
  const repoPaths = findRepos(baseDirs, depth);
  const repos = [];
  for (const p of repoPaths) {
    try { repos.push(await describeRepo(p)); } catch { /* skip unreadable */ }
  }
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return repos;
}

module.exports = { scan, describeRepo, findRepos, defaultBranch, parseWorktrees };
