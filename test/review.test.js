'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const review = require('../server/review');

function sh(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

// A repo with a base commit on `main`, a feature branch with ONE committed change
// (committed.txt), and three uncommitted working changes on top: a modified file, a
// new (untracked) file, and a deleted file.
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-review-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 't@t.t']);
  sh(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'modified.txt'), 'line one\nline two\n');
  fs.writeFileSync(path.join(dir, 'deleted.txt'), 'gone\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  const baseSha = sh(dir, ['rev-parse', 'HEAD']);
  sh(dir, ['checkout', '-q', '-b', 'feature/x']);
  fs.writeFileSync(path.join(dir, 'committed.txt'), 'committed work\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'add committed work']);
  const commitSha = sh(dir, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(dir, 'modified.txt'), 'line ONE changed\nline two\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new\nsecond\n');
  fs.rmSync(path.join(dir, 'deleted.txt'));
  return { dir, baseSha, commitSha };
}

function fileOf(files, name) { return files.find((f) => f.file === name); }

test('base() reports the merge-base with the default branch', async () => {
  const { dir, baseSha } = tempRepo();
  assert.equal(await review.base(dir, 'main'), baseSha);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('base() prefers origin/<default> when the local default ref is stale (branch cut from origin)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-review-stale-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 't@t.t']);
  sh(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'A\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-q', '-m', 'A']);
  const A = sh(dir, ['rev-parse', 'HEAD']);
  // the mainline advances with someone else's commit
  fs.writeFileSync(path.join(dir, 'other.txt'), 'not my work\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-q', '-m', 'B (someone else)']);
  const B = sh(dir, ['rev-parse', 'HEAD']);
  // origin/main is current at B; the feature branch was cut from B and adds a commit
  sh(dir, ['update-ref', 'refs/remotes/origin/main', B]);
  sh(dir, ['checkout', '-q', '-b', 'feature/mine', B]);
  // now (off main) rewind local main to A so it lags behind origin/main
  sh(dir, ['branch', '-f', 'main', A]);
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'my change\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-q', '-m', 'my commit']);

  assert.equal(await review.base(dir, 'main'), B, 'bases on origin/main (B), not the stale local main (A)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commits() excludes commits already on the mainline and includes the branch’s own', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-review-stale2-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 't@t.t']);
  sh(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'A\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-q', '-m', 'A']);
  const A = sh(dir, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(dir, 'other.txt'), 'not my work\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-q', '-m', 'B (someone else)']);
  const B = sh(dir, ['rev-parse', 'HEAD']);
  sh(dir, ['update-ref', 'refs/remotes/origin/main', B]);
  sh(dir, ['checkout', '-q', '-b', 'feature/mine', B]);
  sh(dir, ['branch', '-f', 'main', A]);
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'my change\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-q', '-m', 'my commit']);

  const { commits } = await review.commits(dir, 'main');
  const subjects = commits.map((c) => c.subject);
  assert.deepEqual(subjects, ['my commit'], 'only the branch’s own commit is listed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('working() lists a modified file with status M and add/delete counts', async () => {
  const { dir } = tempRepo();
  const { files } = await review.working(dir);
  const m = fileOf(files, 'modified.txt');
  assert.equal(m.status, 'M');
  assert.equal(m.added, 1);
  assert.equal(m.deleted, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('working() lists an untracked file with status A and its line count added', async () => {
  const { dir } = tempRepo();
  const { files } = await review.working(dir);
  const n = fileOf(files, 'new.txt');
  assert.equal(n.status, 'A');
  assert.equal(n.added, 2);
  assert.equal(n.deleted, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('working() lists a deleted file with status D and deleted count', async () => {
  const { dir } = tempRepo();
  const { files } = await review.working(dir);
  const d = fileOf(files, 'deleted.txt');
  assert.equal(d.status, 'D');
  assert.equal(d.added, 0);
  assert.equal(d.deleted, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('working() excludes files that are already committed on the branch', async () => {
  const { dir } = tempRepo();
  const { files } = await review.working(dir);
  assert.ok(!fileOf(files, 'committed.txt'), 'committed.txt is committed, not an uncommitted change');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commits() lists the branch’s commit with its totals', async () => {
  const { dir } = tempRepo();
  const { commits } = await review.commits(dir, 'main');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].subject, 'add committed work');
  assert.equal(commits[0].fileCount, 1);
  assert.equal(commits[0].added, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitDetail() returns a commit’s files with their inline diffs', async () => {
  const { dir, commitSha } = tempRepo();
  const { files } = await review.commitDetail(dir, 'main', commitSha);
  const f = fileOf(files, 'committed.txt');
  assert.equal(f.status, 'A');
  assert.match(f.diff, /^\+committed work$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitDetail(uncommitted) of a modified file shows the removed and added lines', async () => {
  const { dir } = tempRepo();
  const { files } = await review.commitDetail(dir, 'main', 'uncommitted');
  const m = fileOf(files, 'modified.txt');
  assert.match(m.diff, /^-line one$/m);
  assert.match(m.diff, /^\+line ONE changed$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitDetail(uncommitted) of an untracked file shows it as a new file', async () => {
  const { dir } = tempRepo();
  const { files } = await review.commitDetail(dir, 'main', 'uncommitted');
  const n = fileOf(files, 'new.txt');
  assert.match(n.diff, /new file/);
  assert.match(n.diff, /^\+brand new$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitDetail() carries the structured model alongside the raw patch', async () => {
  const { dir, commitSha } = tempRepo();
  const { files } = await review.commitDetail(dir, 'main', commitSha);
  const f = fileOf(files, 'committed.txt');
  assert.equal(f.parsed.path, 'committed.txt');
  assert.equal(f.parsed.status, 'added');
  assert.equal(f.parsed.hunks.length, 1);
  assert.deepEqual(f.parsed.hunks[0].lines.map((l) => [l.type, l.text]), [['add', 'committed work']]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitDetail(uncommitted) aligns a changed line into one side-by-side row', async () => {
  const { dir } = tempRepo();
  const { files } = await review.commitDetail(dir, 'main', 'uncommitted');
  const m = fileOf(files, 'modified.txt');
  const [h] = m.parsed.hunks;
  const change = h.rows.find((r) => r.type === 'change');
  assert.equal(h.lines[change.left].text, 'line one', 'the old version on the left');
  assert.equal(h.lines[change.right].text, 'line ONE changed', 'the new one on the right');
  assert.equal(h.lines[change.left].oldLine, 1);
  assert.equal(h.lines[change.right].newLine, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitDetail(uncommitted) models a deleted file as one all-removed hunk', async () => {
  const { dir } = tempRepo();
  const { files } = await review.commitDetail(dir, 'main', 'uncommitted');
  const d = fileOf(files, 'deleted.txt');
  assert.equal(d.parsed.status, 'deleted');
  assert.ok(d.parsed.hunks[0].rows.every((r) => r.type === 'del' && r.right === null));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commit() advances HEAD to a new commit', async () => {
  const { dir } = tempRepo();
  const before = sh(dir, ['rev-parse', 'HEAD']);
  const out = await review.commit(dir, 'do the work', {});
  assert.equal(out.ok, true, out.error);
  assert.equal(out.sha, sh(dir, ['rev-parse', 'HEAD']));
  assert.notEqual(out.sha, before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commit() leaves no uncommitted working changes', async () => {
  const { dir } = tempRepo();
  await review.commit(dir, 'do the work', {});
  assert.equal(sh(dir, ['status', '--porcelain']), '');
  fs.rmSync(dir, { recursive: true, force: true });
});
