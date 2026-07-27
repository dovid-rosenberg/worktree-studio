'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const review = require('../server/review');

function sh(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

// A repo with a base commit on `main`, a feature branch checked out, and three
// uncommitted changes: a modified file, a new (untracked) file, a deleted file.
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
  fs.writeFileSync(path.join(dir, 'modified.txt'), 'line ONE changed\nline two\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new\nsecond\n');
  fs.rmSync(path.join(dir, 'deleted.txt'));
  return { dir, baseSha };
}

function fileOf(files, name) { return files.find((f) => f.file === name); }

test('changes() reports the merge-base as the review base', async () => {
  const { dir, baseSha } = tempRepo();
  const out = await review.changes(dir, 'main');
  assert.equal(out.base, baseSha);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('changes() bases on origin/<default> when the local default ref is stale (branch cut from origin)', async () => {
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

  const out = await review.changes(dir, 'main');
  assert.equal(out.base, B, 'bases on origin/main (B), not the stale local main (A)');
  assert.ok(!fileOf(out.files, 'other.txt'), 'a commit already on the mainline is excluded from the diff');
  assert.ok(fileOf(out.files, 'mine.txt'), 'the branch’s own change is still included');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('changes() lists a modified file with status M and add/delete counts', async () => {
  const { dir } = tempRepo();
  const { files } = await review.changes(dir, 'main');
  const m = fileOf(files, 'modified.txt');
  assert.equal(m.status, 'M');
  assert.equal(m.added, 1);
  assert.equal(m.deleted, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('changes() lists an untracked file with status A and its line count added', async () => {
  const { dir } = tempRepo();
  const { files } = await review.changes(dir, 'main');
  const n = fileOf(files, 'new.txt');
  assert.equal(n.status, 'A');
  assert.equal(n.added, 2);
  assert.equal(n.deleted, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('changes() lists a deleted file with status D and deleted count', async () => {
  const { dir } = tempRepo();
  const { files } = await review.changes(dir, 'main');
  const d = fileOf(files, 'deleted.txt');
  assert.equal(d.status, 'D');
  assert.equal(d.added, 0);
  assert.equal(d.deleted, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fileDiff() of a modified file shows the removed and added lines', async () => {
  const { dir } = tempRepo();
  const diff = await review.fileDiff(dir, 'main', 'modified.txt');
  assert.match(diff, /^-line one$/m);
  assert.match(diff, /^\+line ONE changed$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fileDiff() of an untracked file shows it as a new file', async () => {
  const { dir } = tempRepo();
  const diff = await review.fileDiff(dir, 'main', 'new.txt');
  assert.match(diff, /new file/);
  assert.match(diff, /^\+brand new$/m);
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
