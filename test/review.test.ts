import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import * as review from '../server/review.ts';
import type { ReviewFile } from '../server/review.ts';
import { expectErr, expectOk, present } from './helpers.ts';

function sh(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

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

// `fileOf` stays a plain find — one test uses it to assert a file is ABSENT. `mustFind`
// is for the rest, which read fields off the row and want a named failure instead of a
// `possibly undefined` at each of a dozen sites.
function fileOf(files: ReviewFile[], name: string): ReviewFile | undefined {
  return files.find((f) => f.file === name);
}
function mustFind(files: ReviewFile[], name: string): ReviewFile {
  return present(fileOf(files, name), `the diff for ${name}`);
}

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
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'A']);
  const A = sh(dir, ['rev-parse', 'HEAD']);
  // the mainline advances with someone else's commit
  fs.writeFileSync(path.join(dir, 'other.txt'), 'not my work\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'B (someone else)']);
  const B = sh(dir, ['rev-parse', 'HEAD']);
  // origin/main is current at B; the feature branch was cut from B and adds a commit
  sh(dir, ['update-ref', 'refs/remotes/origin/main', B]);
  sh(dir, ['checkout', '-q', '-b', 'feature/mine', B]);
  // now (off main) rewind local main to A so it lags behind origin/main
  sh(dir, ['branch', '-f', 'main', A]);
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'my change\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'my commit']);

  assert.equal(await review.base(dir, 'main'), B, 'bases on origin/main (B), not the stale local main (A)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commits() excludes commits already on the mainline and includes the branch’s own', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-review-stale2-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 't@t.t']);
  sh(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'A\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'A']);
  const A = sh(dir, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(dir, 'other.txt'), 'not my work\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'B (someone else)']);
  const B = sh(dir, ['rev-parse', 'HEAD']);
  sh(dir, ['update-ref', 'refs/remotes/origin/main', B]);
  sh(dir, ['checkout', '-q', '-b', 'feature/mine', B]);
  sh(dir, ['branch', '-f', 'main', A]);
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'my change\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'my commit']);

  const { commits } = await review.commits(dir, 'main');
  const subjects = commits.map((c) => c.subject);
  assert.deepEqual(subjects, ['my commit'], 'only the branch’s own commit is listed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('working() lists a modified file with status M and add/delete counts', async () => {
  const { dir } = tempRepo();
  const { files } = await review.working(dir);
  const m = mustFind(files, 'modified.txt');
  assert.equal(m.status, 'M');
  assert.equal(m.added, 1);
  assert.equal(m.deleted, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('working() lists an untracked file with status A and its line count added', async () => {
  const { dir } = tempRepo();
  const { files } = await review.working(dir);
  const n = mustFind(files, 'new.txt');
  assert.equal(n.status, 'A');
  assert.equal(n.added, 2);
  assert.equal(n.deleted, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('working() lists a deleted file with status D and deleted count', async () => {
  const { dir } = tempRepo();
  const { files } = await review.working(dir);
  const d = mustFind(files, 'deleted.txt');
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
  const f = mustFind(files, 'committed.txt');
  assert.equal(f.status, 'A');
  assert.match(present(f.diff, 'the diff text'), /^\+committed work$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitDetail(uncommitted) of a modified file shows the removed and added lines', async () => {
  const { dir } = tempRepo();
  const { files } = await review.commitDetail(dir, 'main', 'uncommitted');
  const m = mustFind(files, 'modified.txt');
  assert.match(present(m.diff, 'the diff text'), /^-line one$/m);
  assert.match(present(m.diff, 'the diff text'), /^\+line ONE changed$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitDetail(uncommitted) of an untracked file shows it as a new file', async () => {
  const { dir } = tempRepo();
  const { files } = await review.commitDetail(dir, 'main', 'uncommitted');
  const n = mustFind(files, 'new.txt');
  assert.match(present(n.diff, 'the diff text'), /new file/);
  assert.match(present(n.diff, 'the diff text'), /^\+brand new$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitDetail() carries the structured model alongside the raw patch', async () => {
  const { dir, commitSha } = tempRepo();
  const { files } = await review.commitDetail(dir, 'main', commitSha);
  const f = mustFind(files, 'committed.txt');
  assert.equal(present(f.parsed, 'the parsed diff').path, 'committed.txt');
  assert.equal(present(f.parsed, 'the parsed diff').status, 'added');
  assert.equal(present(f.parsed, 'the parsed diff').hunks.length, 1);
  assert.deepEqual(
    present(present(f.parsed, 'the parsed diff').hunks[0]).lines.map((l) => [l.type, l.text]),
    [['add', 'committed work']],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitDetail(uncommitted) aligns a changed line into one side-by-side row', async () => {
  const { dir } = tempRepo();
  const { files } = await review.commitDetail(dir, 'main', 'uncommitted');
  const m = mustFind(files, 'modified.txt');
  const h = present(present(m.parsed, 'the parsed diff').hunks[0], 'the first hunk');
  const change = present(
    h.rows.find((r) => r.type === 'change'),
    'a change row',
  );
  const left = present(h.lines[present(change.left, 'left index')]);
  const right = present(h.lines[present(change.right, 'right index')]);
  assert.equal(left.text, 'line one', 'the old version on the left');
  assert.equal(right.text, 'line ONE changed', 'the new one on the right');
  assert.equal(left.oldLine, 1);
  assert.equal(right.newLine, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitDetail(uncommitted) models a deleted file as one all-removed hunk', async () => {
  const { dir } = tempRepo();
  const { files } = await review.commitDetail(dir, 'main', 'uncommitted');
  const d = mustFind(files, 'deleted.txt');
  assert.equal(present(d.parsed, 'the parsed diff').status, 'deleted');
  assert.ok(
    present(present(d.parsed, 'the parsed diff').hunks[0]).rows.every(
      (r) => r.type === 'del' && r.right === null,
    ),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commit() advances HEAD to a new commit', async () => {
  const { dir } = tempRepo();
  const before = sh(dir, ['rev-parse', 'HEAD']);
  const out = expectOk(await review.commit(dir, 'do the work', {}), 'commit()');
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

// A rename is the one case where git's human-readable and -z outputs disagree:
// --numstat writes `src/{math.js => calc.js}` (one field) while --name-status writes
// only the new path, so keying off both produced a phantom entry alongside the real
// file. The phantom had no parsed diff — it drew an empty file block and made the
// uncommitted view claim "nothing left to stage", which reads as data loss.
test('working() reports a rename once, keyed on the new path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-rename-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 't@t.t']);
  sh(dir, ['config', 'user.name', 't']);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/math.js'), 'a\nb\nc\nd\ne\nf\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  sh(dir, ['mv', 'src/math.js', 'src/calc.js']);

  const { files } = await review.working(dir);
  assert.equal(files.length, 1, 'a rename is one file, not two');
  assert.equal(files[0].file, 'src/calc.js');
  assert.equal(files[0].status, 'R');
  assert.equal(files[0].oldFile, 'src/math.js');
  assert.ok(!files.some((f) => f.file.includes('=>')), 'no phantom "old => new" entry');
});

// The reason -z is required rather than just parsing the arrow form: " => " is legal
// in a filename, so the readable output is genuinely ambiguous.
test('working() treats a filename containing " => " as one real file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-arrow-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 't@t.t']);
  sh(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a => b.txt'), 'x\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  fs.writeFileSync(path.join(dir, 'a => b.txt'), 'x\ny\n');

  const { files } = await review.working(dir);
  assert.equal(files.length, 1);
  assert.equal(files[0].file, 'a => b.txt');
  assert.equal(files[0].added, 1);
});

test('commitDetail() reports a committed rename once, with a parsed diff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-crename-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 't@t.t']);
  sh(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'old.js'), 'a\nb\nc\nd\ne\nf\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  sh(dir, ['mv', 'old.js', 'new.js']);
  sh(dir, ['commit', '-q', '-am', 'rename it']);
  const sha = sh(dir, ['rev-parse', 'HEAD']);

  const { files } = await review.commitDetail(dir, 'main', sha);
  assert.equal(files.length, 1, 'a renamed file is one entry');
  assert.equal(files[0].file, 'new.js');
  assert.ok(!files.some((f) => f.file.includes('=>')), 'no phantom entry');
});

// ---------------------------------------------------------------------------
// `sha` reaches a git argv, so it is untrusted input until proved otherwise
//
// `git show --format= --numstat -z <sha>` spliced it in bare, and both callers
// feed it straight from a query string — so `?sha=--output=/tmp/x` was read by
// git as an OPTION, exited 0 and truncated that path. A GET that writes to the
// filesystem is the wrong shape whatever gates sit in front of it.
// ---------------------------------------------------------------------------

test('a sha that is really a git option cannot write a file', async () => {
  const { dir } = tempRepo();
  const victim = path.join(os.tmpdir(), `wts-victim-${process.pid}-${Date.now()}.txt`);
  fs.rmSync(victim, { force: true });

  await assert.rejects(() => review.commitDetail(dir, 'main', `--output=${victim}`), /invalid commit sha/);
  assert.equal(fs.existsSync(victim), false, `git wrote ${victim} — the option reached the argv`);

  fs.rmSync(victim, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isValidSha accepts object names and "uncommitted", and nothing else', () => {
  for (const good of ['uncommitted', 'abcd', 'a1b2c3d4', 'f'.repeat(40), 'DEADBEEF']) {
    assert.equal(review.isValidSha(good), true, good);
  }
  for (const bad of [
    '--output=/tmp/x',
    '-n',
    'HEAD',
    'main',
    'abc',
    'f'.repeat(41),
    '',
    null,
    undefined,
    'abc def',
    '../etc',
  ]) {
    assert.equal(review.isValidSha(bad), false, String(bad));
  }
});

test('a real sha still resolves, with the option terminator in place', async () => {
  const { dir, commitSha } = tempRepo();
  const detail = await review.commitDetail(dir, 'main', commitSha);
  assert.deepEqual(
    detail.files.map((f) => f.file),
    ['committed.txt'],
  );
  assert.ok(present(present(detail.files[0]).diff, 'the diff text').includes('committed work'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// `paths` reaches a git argv too
// ---------------------------------------------------------------------------

test('a path that is really a git flag is treated as a pathspec, not an option', async () => {
  const { dir } = tempRepo();
  const target = path.join(dir, 'modified.txt');
  const modeBefore = fs.statSync(target).mode;

  // Without the `--` separator this is `git add --chmod=+x modified.txt`, which git
  // honours: the file is staged executable.
  const r = await review.commit(dir, 'msg', { paths: ['--chmod=+x', 'modified.txt'] });

  const refused = expectErr(r, 'a --chmod pathspec');
  assert.match(refused.error, /pathspec/, refused.error);
  const staged = sh(dir, ['ls-files', '-s', 'modified.txt']);
  assert.ok(!staged.startsWith('100755'), `modified.txt was staged as ${staged.split(' ')[0]}`);
  assert.equal(fs.statSync(target).mode, modeBefore);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a non-string entry in paths is a rejected request, not a TypeError', async () => {
  const { dir } = tempRepo();
  // Deliberately ill-typed input: the point is that a bad request is answered, not thrown.
  // Deliberately ill-typed input, so the casts are the test: a caller CAN send this
  // over the wire, and the point is that it is answered rather than thrown.
  for (const bad of [[123], [null], [{}], ['']] as unknown as string[][]) {
    const r = await review.commit(dir, 'msg', { paths: bad });
    assert.match(expectErr(r, JSON.stringify(bad)).error, /non-empty string/);
  }
  const r = await review.commit(dir, 'msg', { paths: 'modified.txt' as unknown as string[] });
  assert.match(expectErr(r, 'a non-array paths').error, /must be an array/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('committing a real list of paths still works', async () => {
  const { dir } = tempRepo();
  expectOk(await review.commit(dir, 'just the new file', { paths: ['new.txt'] }), 'commit()');
  assert.equal(sh(dir, ['show', '--name-only', '--format=', 'HEAD']).trim(), 'new.txt');
  fs.rmSync(dir, { recursive: true, force: true });
});
