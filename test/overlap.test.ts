/*
 * Collision radar and drift (server/overlap.ts), against REAL git repos.
 *
 * The whole value is arithmetic over merge-bases, and a fake that returns canned file
 * lists would prove only that the intersection operator works. So these build actual
 * worktrees, commit into them, and move the base underneath — which is also the only way
 * to catch the thing most likely to be wrong: comparing against the branch tip instead of
 * the merge-base, which silently reports every commit made on master as "yours".
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createOverlapFeed } from '../server/overlap.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-overlap-'));
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  for (const f of ['shared.js', 'a-only.js', 'b-only.js', 'untouched.js']) {
    fs.writeFileSync(path.join(dir, f), '// base\n');
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A worktree on its own branch, with `files` edited and committed. */
function branchWith(dir: string, name: string, files: string[]): string {
  const wt = path.join(dir, '.worktrees', name);
  git(dir, 'worktree', 'add', '-q', '-b', `feature/${name}`, wt);
  for (const f of files) fs.writeFileSync(path.join(wt, f), `// ${name}\n`);
  git(wt, 'add', '.');
  git(wt, 'commit', '-qm', name);
  return wt;
}

const feature = (name: string, repoName: string, wt: string) => ({
  name,
  members: [{ repo: repoName, path: wt, branch: `feature/${name}` }],
});

test('names the files two features are both changing, and says so on both', async () => {
  const dir = repo();
  const a = branchWith(dir, 'alpha', ['shared.js', 'a-only.js']);
  const b = branchWith(dir, 'beta', ['shared.js', 'b-only.js']);

  const feed = createOverlapFeed();
  await feed.refresh([feature('alpha', 'r', a), feature('beta', 'r', b)], () => 'master');
  const snap = feed.snapshot();

  assert.deepEqual(snap.alpha.collisions, [{ feature: 'beta', repo: 'r', files: ['shared.js'] }]);
  // Symmetric: whichever one you are looking at is the one that has to warn you.
  assert.deepEqual(snap.beta.collisions, [{ feature: 'alpha', repo: 'r', files: ['shared.js'] }]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('says nothing about a feature that shares no files', async () => {
  const dir = repo();
  const a = branchWith(dir, 'alpha', ['a-only.js']);
  const b = branchWith(dir, 'beta', ['b-only.js']);

  const feed = createOverlapFeed();
  await feed.refresh([feature('alpha', 'r', a), feature('beta', 'r', b)], () => 'master');
  assert.deepEqual(feed.snapshot().alpha.collisions, []);
  assert.deepEqual(feed.snapshot().beta.collisions, []);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('never pairs features across repos — they cannot collide there', async () => {
  const one = repo();
  const two = repo();
  const a = branchWith(one, 'alpha', ['shared.js']);
  const b = branchWith(two, 'beta', ['shared.js']);

  const feed = createOverlapFeed();
  // Same filename, different repos. A path-only comparison would call this a collision.
  await feed.refresh([feature('alpha', 'one', a), feature('beta', 'two', b)], () => 'master');
  assert.deepEqual(feed.snapshot().alpha.collisions, []);
  assert.deepEqual(feed.snapshot().beta.collisions, []);

  fs.rmSync(one, { recursive: true, force: true });
  fs.rmSync(two, { recursive: true, force: true });
});

test('counts drift from the merge-base, not from the branch tip', async () => {
  /*
   * THE TRAP. Diffing `base..HEAD` rather than `mergeBase..HEAD` folds every commit made
   * on master since you branched into "files you changed" — so a busy repo reports a
   * feature as touching half the codebase, and every pair collides with every other.
   * Here master gains a commit to `untouched.js` AFTER the branch is cut; the feature must
   * still report exactly the one file it edited, and a behind-count of 1.
   */
  const dir = repo();
  const a = branchWith(dir, 'alpha', ['a-only.js']);
  fs.writeFileSync(path.join(dir, 'untouched.js'), '// moved on\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'master moves on');

  const feed = createOverlapFeed();
  await feed.refresh([feature('alpha', 'r', a)], () => 'master');
  const d = feed.snapshot().alpha;

  assert.equal(d.behind, 1, 'one commit on master the branch does not have');
  assert.equal(d.ahead, 1, 'one commit of its own');
  assert.deepEqual(d.drift[0].conflicts, [], 'different files — nothing to conflict');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('flags the files the base has also changed — what a rebase will actually fight', async () => {
  const dir = repo();
  const a = branchWith(dir, 'alpha', ['shared.js', 'a-only.js']);
  // master edits one of the same files after the branch was cut.
  fs.writeFileSync(path.join(dir, 'shared.js'), '// master edit\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'master touches shared');

  const feed = createOverlapFeed();
  await feed.refresh([feature('alpha', 'r', a)], () => 'master');
  assert.deepEqual(feed.snapshot().alpha.drift[0].conflicts, ['shared.js']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('reports the WORST repo when a feature spans several', async () => {
  // One stale half of a feature is a stale feature — averaging would hide it.
  const one = repo();
  const two = repo();
  const a1 = branchWith(one, 'alpha', ['a-only.js']);
  const a2 = branchWith(two, 'alpha', ['a-only.js']);
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(two, 'untouched.js'), `// ${i}\n`);
    git(two, 'add', '.');
    git(two, 'commit', '-qm', `move ${i}`);
  }

  const feed = createOverlapFeed();
  await feed.refresh(
    [{ name: 'alpha', members: [{ repo: 'one', path: a1 }, { repo: 'two', path: a2 }] }],
    () => 'master',
  );
  const s = feed.snapshot().alpha;
  assert.equal(s.behind, 3, 'the worst repo, not the average');
  assert.equal(s.ahead, 2, 'its own commits across both repos');

  fs.rmSync(one, { recursive: true, force: true });
  fs.rmSync(two, { recursive: true, force: true });
});

test('an unchanged answer does not push a frame', async () => {
  /*
   * `refresh` returning false is what stops a frame going to every client for an answer
   * nobody's git history justifies — the same rule ci.ts follows with its signature.
   * Driven through the injected reader so the assertion is about the FEED's contract,
   * not about how fast git is.
   */
  let reads = 0;
  const feed = createOverlapFeed({
    read: async () => {
      reads += 1;
      return { headSha: 'h', baseSha: 'b', changed: ['a-only.js'], behind: 0, ahead: 1, conflicts: [] };
    },
  });
  const f = { name: 'alpha', members: [{ repo: 'r', path: '/w/alpha' }] };

  assert.equal(await feed.refresh([f], () => 'master'), true, 'the first answer is new');
  assert.equal(reads, 1, 'one read per member per sweep');
  assert.equal(await feed.refresh([f], () => 'master'), false, 'an identical answer is not news');
  assert.equal(reads, 2);
});

test('forgets a worktree that has been removed', async () => {
  const dir = repo();
  const a = branchWith(dir, 'alpha', ['shared.js']);
  const b = branchWith(dir, 'beta', ['shared.js']);
  const feed = createOverlapFeed();
  await feed.refresh([feature('alpha', 'r', a), feature('beta', 'r', b)], () => 'master');
  assert.equal(feed.snapshot().alpha.collisions.length, 1);

  // beta goes away: alpha must stop being warned about it.
  await feed.refresh([feature('alpha', 'r', a)], () => 'master');
  assert.deepEqual(feed.snapshot().alpha.collisions, []);
  assert.equal(feed.snapshot().beta, undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unreadable worktree contributes nothing rather than a row of zeroes', async () => {
  const dir = repo();
  const gone = path.join(dir, '.worktrees', 'never-made');
  const feed = createOverlapFeed();
  await feed.refresh([feature('ghost', 'r', gone)], () => 'master');
  assert.equal(feed.snapshot().ghost, undefined, '"no drift" and "unknown" are different answers');
  fs.rmSync(dir, { recursive: true, force: true });
});
