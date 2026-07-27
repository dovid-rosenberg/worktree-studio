'use strict';
// Per-worktree review backend: the branch's diff vs its merge-base with the
// default branch (committed delta + uncommitted working changes), single-file
// diffs, and staged commits. All git via arg-arrays through git/gitFull.
const fs = require('fs');
const path = require('path');
const { git, gitFull } = require('./util');
const { parsePatch } = require('./diff');

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

// The working tree's UNCOMMITTED changes (vs HEAD), de-duped by path: tracked changes
// from git diff HEAD (numstat counts + name-status), untracked files from git status
// --porcelain (status 'A', line count as added). Excludes everything already committed.
async function working(worktreePath) {
  const byPath = new Map();
  const get = (f) => {
    if (!byPath.has(f)) byPath.set(f, { file: f, status: 'M', added: 0, deleted: 0 });
    return byPath.get(f);
  };

  const numstat = await git(worktreePath, ['diff', '--numstat', 'HEAD']);
  for (const line of numstat.split('\n')) {
    if (!line) continue;
    const [a, d, ...rest] = line.split('\t');
    const e = get(rest.join('\t'));
    e.added = a === '-' ? 0 : Number(a) || 0;
    e.deleted = d === '-' ? 0 : Number(d) || 0;
  }

  const nameStatus = await git(worktreePath, ['diff', '--name-status', 'HEAD']);
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

  return { files: [...byPath.values()] };
}

// Raw unified diff for one working-tree file (vs HEAD); untracked → /dev/null diff.
async function workingFileDiff(worktreePath, file) {
  const r = await gitFull(worktreePath, ['diff', 'HEAD', '--', file]);
  if (r.stdout) return r.stdout;
  const st = await git(worktreePath, ['status', '--porcelain', '--', file]);
  if (st.startsWith('??')) {
    const u = await gitFull(worktreePath, ['diff', '--no-index', '--', '/dev/null', file]);
    return u.stdout;
  }
  return r.stdout;
}

// The commits on this branch (base..HEAD), newest first, each with its totals. One
// `git log --numstat` call: a REC-prefixed header line per commit, then its numstat rows.
async function commits(worktreePath, defaultBranch) {
  const b = await base(worktreePath, defaultBranch);
  const SEP = '\x1f'; const REC = '\x1e';
  const raw = await git(worktreePath, ['log', `--format=${REC}%H${SEP}%an${SEP}%ar${SEP}%s`, '--numstat', `${b}..HEAD`]);
  const list = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith(REC)) {
      const [sha, author, when, subject] = line.slice(1).split(SEP);
      cur = { sha, author, when, subject: subject || '', added: 0, deleted: 0, fileCount: 0 };
      list.push(cur);
    } else if (line.trim() && cur) {
      const [a, d] = line.split('\t');
      cur.added += a === '-' ? 0 : Number(a) || 0;
      cur.deleted += d === '-' ? 0 : Number(d) || 0;
      cur.fileCount += 1;
    }
  }
  return { base: b, commits: list };
}

// Per-file breakdown (status + counts + unified diff) for a single commit, or for the
// working tree when sha === 'uncommitted'. Diffs are inline so the pane can show all
// files at once and filter to one client-side without another round-trip.
async function commitDetail(worktreePath, defaultBranch, sha) {
  if (sha === 'uncommitted') return workingDetail(worktreePath);
  const byPath = new Map();
  const get = (f) => {
    if (!byPath.has(f)) byPath.set(f, { file: f, status: 'M', added: 0, deleted: 0 });
    return byPath.get(f);
  };
  const numstat = await git(worktreePath, ['show', '--format=', '--numstat', sha]);
  for (const line of numstat.split('\n')) {
    if (!line) continue;
    const [a, d, ...rest] = line.split('\t');
    const e = get(rest.join('\t'));
    e.added = a === '-' ? 0 : Number(a) || 0;
    e.deleted = d === '-' ? 0 : Number(d) || 0;
  }
  const nameStatus = await git(worktreePath, ['show', '--format=', '--name-status', sha]);
  for (const line of nameStatus.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    get(parts[parts.length - 1]).status = parts[0][0];
  }
  const files = [...byPath.values()];
  for (const f of files) {
    f.diff = (await gitFull(worktreePath, ['show', '--format=', sha, '--', f.file])).stdout;
    f.parsed = structure(f.diff);
  }
  return { files };
}

// The working tree's uncommitted changes with inline diffs.
async function workingDetail(worktreePath) {
  const { files } = await working(worktreePath);
  for (const f of files) {
    f.diff = await workingFileDiff(worktreePath, f.file);
    f.parsed = structure(f.diff);
  }
  return { files };
}

// The structured side-by-side model for one file's diff (see server/diff.js): hunks with
// aligned left/right rows and line numbers on both sides, so a client can render either
// layout without re-parsing the text. `diff` stays alongside it — the raw patch is still
// what git speaks, and dropping it would break anything that renders the text directly.
function structure(diffText) {
  if (!diffText) return null;
  // Each diff here is already scoped to a single path, so there is exactly one entry.
  return parsePatch(diffText)[0] || null;
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

module.exports = { base, working, commits, commitDetail, commit };
