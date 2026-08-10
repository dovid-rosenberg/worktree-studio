/*
 * Committing must not destroy what the user deliberately staged.
 *
 * `review.commit()` ran `git add -A` whenever `paths` was absent — so there was no way at
 * all to say "commit the index as it stands". Stage one hunk of nine in the review panel,
 * commit, and you got all nine plus every untracked file in the worktree. hunks.ts states
 * that hunk staging "coexists with (does not replace) the file-level staging in
 * review.commit()"; that line is what made it untrue.
 *
 * Real git repos, because the whole finding is about what the index actually contains.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { commit } from '../server/review.ts';

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-commit-'));
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', dir, ...a], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  git('init', '-b', 'main');
  // Identity in the repo's OWN config, not just in this helper's env.
  // The env only reaches git calls THIS file makes; the code under test shells out
  // separately and would be left relying on git's auto-detection — which works on a
  // developer machine and fails in a container whose hostname it will not guess from.
  // That is a green suite locally and a red one in CI, for a reason nothing reports.
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
  git('add', '-A');
  git('commit', '-m', 'init');
  return dir;
}

const show = (dir: string) =>
  execFileSync('git', ['-C', dir, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();

test('a STAGED file is committed alone — the rest of the worktree is left where it is', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one changed\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two changed\n');
  fs.writeFileSync(path.join(dir, 'untracked.log'), 'noise\n');
  execFileSync('git', ['-C', dir, 'add', '--', 'a.txt']); // the deliberate act

  const r = await commit(dir, 'only a');
  assert.equal(r.ok, true);

  assert.deepEqual(show(dir), ['a.txt'], 'b.txt and untracked.log must NOT have been swept in');
  const left = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.match(left, /b\.txt/, 'the unstaged change is still there to commit later');
  assert.match(left, /untracked\.log/, 'the untracked file is still untracked');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('with an EMPTY index and no paths, commit still means "everything" — the plain case', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one changed\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'added\n');

  const r = await commit(dir, 'sweep');
  assert.equal(r.ok, true);
  assert.deepEqual(show(dir), ['a.txt', 'new.txt'], 'nothing staged means stage it all');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('explicit paths still win, and still only take what was named', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one changed\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two changed\n');

  const r = await commit(dir, 'just b', { paths: ['b.txt'] });
  assert.equal(r.ok, true);
  assert.deepEqual(show(dir), ['b.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});
