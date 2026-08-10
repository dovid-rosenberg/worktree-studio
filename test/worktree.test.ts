import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import * as worktree from '../server/worktree.ts';
import { expectErr, expectOk } from './helpers.ts';

function sh(cwd: string, cmd: string, args: string[]): void {
  execFileSync(cmd, args, { cwd, stdio: 'ignore' });
}

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-repo-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 't@t.t']);
  sh(dir, 'git', ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  // a gitignored local config + run config that must be carried into worktrees
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n.worktrees/\nconfig/*-config.ts\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'dev-config.ts'), 'module.exports={};\n');
  fs.mkdirSync(path.join(dir, '.idea', 'runConfigurations'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.idea', 'runConfigurations', 'start.xml'), '<component/>\n');
  sh(dir, 'git', ['add', 'README.md', '.gitignore']);
  sh(dir, 'git', ['commit', '-q', '-m', 'init']);
  return dir;
}

test('create() makes a worktree and carries gitignored run configs + local files', async () => {
  const repo = tempRepo();
  const res = await worktree.create(repo, 'feature/foo', 'feature-foo', {
    fetch: false,
    copyPatterns: ['.env', 'config/*-config.ts'],
  });
  const made = expectOk(res, 'create()');
  assert.ok(fs.existsSync(made.path), 'worktree dir exists');
  assert.ok(fs.existsSync(path.join(made.path, '.env')), '.env copied');
  assert.ok(fs.existsSync(path.join(made.path, 'config', 'dev-config.ts')), 'dev-config.ts copied');
  assert.ok(
    fs.existsSync(path.join(made.path, '.idea', 'runConfigurations', 'start.xml')),
    'run config copied',
  );
  assert.equal(made.copied.runConfigs, 1);
  assert.equal(made.copied.files, 2);
  assert.equal(made.created, true);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('create() refuses a duplicate worktree name', async () => {
  const repo = tempRepo();
  await worktree.create(repo, 'feature/foo', 'dup', { fetch: false, copyPatterns: [] });
  const again = await worktree.create(repo, 'feature/bar', 'dup', { fetch: false, copyPatterns: [] });
  assert.match(expectErr(again, 'a duplicate create()').error, /already exists/);
  fs.rmSync(repo, { recursive: true, force: true });
});

// A minimal repo without .idea run configs, so a created worktree has no
// untracked files and `git worktree remove` (no --force) succeeds.
function plainRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-plain-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 't@t.t']);
  sh(dir, 'git', ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\n');
  sh(dir, 'git', ['add', '.']);
  sh(dir, 'git', ['commit', '-q', '-m', 'init']);
  return dir;
}

test('remove() deletes the worktree directory', async () => {
  const repo = plainRepo();
  const res = await worktree.create(repo, 'feature/gone', 'gone', { fetch: false, copyPatterns: [] });
  assert.ok(fs.existsSync(res.path), 'worktree created');
  const out = await worktree.remove(repo, res.path);
  expectOk(out, 'remove()');
  assert.equal(fs.existsSync(res.path), false, 'worktree dir removed');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('remove() with { deleteBranch } also deletes the branch', async () => {
  const repo = plainRepo();
  const res = await worktree.create(repo, 'feature/gone2', 'gone2', { fetch: false, copyPatterns: [] });
  assert.equal(await worktree.branchExists(repo, 'feature/gone2'), true, 'branch exists before remove');
  const out = await worktree.remove(repo, res.path, { deleteBranch: true, branch: 'feature/gone2' });
  assert.equal(expectOk(out, 'remove()').branchDeleted, true, 'branch reported deleted');
  assert.equal(await worktree.branchExists(repo, 'feature/gone2'), false, 'branch is gone');
  fs.rmSync(repo, { recursive: true, force: true });
});

/*
 * An UNMERGED branch is refused by `git branch -d`, and that refusal must reach the user.
 *
 * `remove()` recorded only `branchDeleted = d.code === 0` and threw the stderr away — and
 * `branchDeleted` had no consumer anywhere in the codebase, only its declaration and the
 * two lines setting it. So ticking "Also delete the branches" on a feature with unmerged
 * work answered a clean success, toasted "Deleted <name>", and left every branch standing.
 */
test('remove() REPORTS a branch it could not delete, instead of claiming success', async () => {
  const repo = plainRepo();
  const res = await worktree.create(repo, 'feature/unmerged', 'unmerged', { fetch: false, copyPatterns: [] });
  // Commit inside the worktree so the branch is genuinely ahead — what `-d` refuses.
  fs.writeFileSync(path.join(res.path, 'work.txt'), 'unmerged work\n');
  sh(res.path, 'git', ['add', '-A']);
  sh(res.path, 'git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'ahead']);

  const out = await worktree.remove(repo, res.path, { deleteBranch: true, branch: 'feature/unmerged' });
  const ok = expectOk(out, 'remove()');

  // The worktree really did go, so this is a PARTIAL outcome, not a failure.
  assert.equal(fs.existsSync(res.path), false, 'the worktree is gone');
  assert.equal(ok.branchDeleted, false);
  assert.ok(ok.branchError, 'the refusal is carried, not swallowed');
  assert.match(ok.branchError || '', /not fully merged|feature\/unmerged/);
  assert.equal(await worktree.branchExists(repo, 'feature/unmerged'), true, 'the branch survived');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a branch that DID delete carries no error — the quiet path stays quiet', async () => {
  const repo = plainRepo();
  const res = await worktree.create(repo, 'feature/clean', 'clean', { fetch: false, copyPatterns: [] });
  const out = await worktree.remove(repo, res.path, { deleteBranch: true, branch: 'feature/clean' });
  const ok = expectOk(out, 'remove()');
  assert.equal(ok.branchDeleted, true);
  assert.equal('branchError' in ok, false, 'nothing to report means no key at all');
  fs.rmSync(repo, { recursive: true, force: true });
});

/*
 * A worktree holding untracked files must still be deletable.
 *
 * `git worktree remove` refuses a tree with modified or untracked files, and Studio's own
 * "Install dependencies" button creates exactly that — npm writes an untracked
 * package-lock.json. With no force option on either delete route and no prune route
 * anywhere, such a worktree could never be removed through the API at all: the same error,
 * forever. remove()'s own fallback string already read "(use force?)", so the gap was
 * known; there was simply no argument to answer it with.
 */
test('remove() REFUSES a worktree with untracked files, and says why', async () => {
  const repo = plainRepo();
  const res = await worktree.create(repo, 'feature/dirty', 'dirty', { fetch: false, copyPatterns: [] });
  fs.writeFileSync(path.join(res.path, 'package-lock.json'), '{}\n'); // what install-deps leaves

  const out = await worktree.remove(repo, res.path);
  const err = expectErr(out, 'remove()');
  // git's own line names the blocking file and the flag — the one actionable thing.
  assert.match(err.error, /untracked|--force/);
  assert.equal(fs.existsSync(res.path), true, 'still there, which is why force must exist');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('remove({ force }) gets past it', async () => {
  const repo = plainRepo();
  const res = await worktree.create(repo, 'feature/dirty2', 'dirty2', { fetch: false, copyPatterns: [] });
  fs.writeFileSync(path.join(res.path, 'package-lock.json'), '{}\n');

  const out = await worktree.remove(repo, res.path, { force: true });
  expectOk(out, 'remove({force})');
  assert.equal(fs.existsSync(res.path), false, 'the worktree is gone');
  fs.rmSync(repo, { recursive: true, force: true });
});
