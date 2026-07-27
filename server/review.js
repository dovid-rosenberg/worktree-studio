'use strict';
// Per-worktree review backend: the branch's diff vs its merge-base with the
// default branch (committed delta + uncommitted working changes), single-file
// diffs, and staged commits. All git via arg-arrays through git/gitFull.
const fs = require('fs');
const path = require('path');
const { git, gitFull } = require('./util');

// The review baseline: the merge-base of HEAD with the default branch. A branch is
// often cut from origin/<default> while the LOCAL <default> ref lags behind — basing
// on the stale local ref drags in commits already on the mainline (the classic "why
// am I seeing another branch's changes?"). So when both a local and a remote merge-base
// exist, use the one CLOSEST to HEAD (the descendant of the two): the tightest correct
// baseline no matter which ref is stale.
async function base(worktreePath, defaultBranch) {
  const local = await git(worktreePath, ['merge-base', 'HEAD', defaultBranch]);
  const remote = await git(worktreePath, ['merge-base', 'HEAD', `origin/${defaultBranch}`]);
  if (local && remote && local !== remote) {
    const localIsAncestor = (await gitFull(worktreePath, ['merge-base', '--is-ancestor', local, remote])).code === 0;
    return localIsAncestor ? remote : local;
  }
  return local || remote || defaultBranch;
}

function countLines(worktreePath, rel) {
  try {
    const content = fs.readFileSync(path.join(worktreePath, rel), 'utf8');
    if (!content) return 0;
    const parts = content.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts.length;
  } catch { return 0; }
}

// The branch's total delta vs base plus uncommitted working changes, de-duped by
// path: tracked changes from git diff (numstat counts + name-status), untracked
// files from git status --porcelain (status 'A', line count as added).
async function changes(worktreePath, defaultBranch) {
  const b = await base(worktreePath, defaultBranch);
  const byPath = new Map();
  const get = (f) => {
    if (!byPath.has(f)) byPath.set(f, { file: f, status: 'M', added: 0, deleted: 0 });
    return byPath.get(f);
  };

  const numstat = await git(worktreePath, ['diff', '--numstat', b]);
  for (const line of numstat.split('\n')) {
    if (!line) continue;
    const [a, d, ...rest] = line.split('\t');
    const e = get(rest.join('\t'));
    e.added = a === '-' ? 0 : Number(a) || 0;
    e.deleted = d === '-' ? 0 : Number(d) || 0;
  }

  const nameStatus = await git(worktreePath, ['diff', '--name-status', b]);
  for (const line of nameStatus.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    get(parts[parts.length - 1]).status = parts[0][0];
  }

  const porcelain = await git(worktreePath, ['status', '--porcelain']);
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('??')) continue;
    const f = line.slice(3);
    const e = get(f);
    e.status = 'A';
    e.added = countLines(worktreePath, f);
  }

  return { base: b, files: [...byPath.values()] };
}

// Raw unified diff for one file; untracked files fall back to a /dev/null diff.
async function fileDiff(worktreePath, defaultBranch, file) {
  const b = await base(worktreePath, defaultBranch);
  const r = await gitFull(worktreePath, ['diff', b, '--', file]);
  if (r.stdout) return r.stdout;
  const st = await git(worktreePath, ['status', '--porcelain', '--', file]);
  if (st.startsWith('??')) {
    const u = await gitFull(worktreePath, ['diff', '--no-index', '--', '/dev/null', file]);
    return u.stdout;
  }
  return r.stdout;
}

// Stage the given paths (or everything) and commit. Returns { ok, sha, error }.
async function commit(worktreePath, message, { amend, paths } = {}) {
  const add = paths && paths.length ? ['add', ...paths] : ['add', '-A'];
  const a = await gitFull(worktreePath, add);
  if (a.code !== 0) return { ok: false, error: a.stderr.trim() || 'git add failed' };
  const args = ['commit', '-m', message];
  if (amend) args.push('--amend');
  const c = await gitFull(worktreePath, args);
  if (c.code !== 0) return { ok: false, error: c.stderr.trim() || c.stdout.trim() || 'git commit failed' };
  return { ok: true, sha: await git(worktreePath, ['rev-parse', 'HEAD']) };
}

module.exports = { base, changes, fileDiff, commit };
