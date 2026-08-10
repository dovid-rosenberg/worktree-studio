import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import * as gitMod from '../server/git.ts';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

/** A repo with two commits on `main`. */
function repo(): { dir: string; g: (...a: string[]) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-git-'));
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: ENV });
  g('init', '-b', 'main');
  // Identity in the repo's OWN config, not just in this helper's env.
  // The env only reaches git calls THIS file makes; the code under test shells out
  // separately and would be left relying on git's auto-detection — which works on a
  // developer machine and fails in a container whose hostname it will not guess from.
  // That is a green suite locally and a red one in CI, for a reason nothing reports.
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  g('add', '-A');
  g('commit', '-m', 'one');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  g('commit', '-am', 'two');
  return { dir, g };
}

/*
 * A DETACHED HEAD has no branch, and `rev-parse --abbrev-ref HEAD` says so by answering
 * the literal string "HEAD".
 *
 * That string was accepted as a branch name and travelled all the way to the review
 * baseline, where review.base() resolved it to the current commit — so a branch diffed
 * against itself, the Changes pane showed nothing, and nothing explained why. Detached is
 * an ordinary state: it is where `git bisect` and a checked-out tag leave you.
 */
test('defaultBranch never answers the literal string HEAD', async () => {
  const { dir, g } = repo();
  g('checkout', '--detach', 'HEAD~1');

  const def = await gitMod.defaultBranch(dir);
  assert.notEqual(def, 'HEAD', 'that is git saying "no branch", not a branch name');
  assert.equal(def, 'main');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('defaultBase never answers HEAD either — it shares the same fallback', () => {
  // The two used to be separate implementations with separate fallbacks; the whole point
  // of consolidating them is that a fix like this lands in both.
  const { dir, g } = repo();
  g('checkout', '--detach', 'HEAD~1');
  return gitMod.defaultBase(dir).then((base) => {
    assert.notEqual(base, 'HEAD');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('on a normal branch, the branch is what comes back', async () => {
  const { dir } = repo();
  assert.equal(await gitMod.defaultBranch(dir), 'main');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('originHead is empty when there is no origin/HEAD — it does not guess', async () => {
  // checkout.ts depends on this: it must be able to tell "no default branch" from a
  // guess, because it REFUSES to switch rather than switching somewhere invented.
  const { dir } = repo();
  assert.equal(await gitMod.originHead(dir), '');
  fs.rmSync(dir, { recursive: true, force: true });
});
