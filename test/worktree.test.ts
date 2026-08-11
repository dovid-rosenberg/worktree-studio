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

/*
 * backfill(): the copy step, run against a worktree that already exists.
 *
 * The whole reason "never run `git worktree add`, use `wt`" had to be written down as a
 * RULE is that a bare worktree add silently drops these files — the run menu comes up
 * empty and the app falls back to default config without erroring. The copy only ever
 * ran inside create(), so a worktree an agent made by hand could never get them. This
 * is that copy, made re-runnable.
 */
function bareWorktree(repo: string, name: string): string {
  const dest = path.join(repo, '.worktrees', name);
  sh(repo, 'git', ['worktree', 'add', '-q', '-b', `feature/${name}`, dest]);
  return dest;
}

test('backfill() carries the files a bare `git worktree add` dropped', async () => {
  const repo = tempRepo();
  const dest = bareWorktree(repo, 'by-hand');
  assert.equal(fs.existsSync(path.join(dest, '.env')), false, 'the bare add really did drop it');

  const copied = await worktree.backfill(repo, dest, {
    copyPatterns: ['.env', 'config/*-config.ts'],
    copyAlways: ['.idea/runConfigurations/*.xml'],
  });
  assert.equal(fs.readFileSync(path.join(dest, '.env'), 'utf8'), 'SECRET=1\n');
  assert.ok(fs.existsSync(path.join(dest, '.idea', 'runConfigurations', 'start.xml')), 'run config copied');
  assert.equal(copied.runConfigs, 1);
  assert.equal(copied.files, 2, '.env and the dev config');
  fs.rmSync(repo, { recursive: true, force: true });
});

/*
 * The difference between backfill and create's copy, and the reason it is a separate
 * entry point rather than a flag nobody sets: at create time the destination is empty,
 * so overwriting is meaningless. A worktree discovered later has been LIVED IN — an
 * agent may have edited the .env it is missing pieces of — and clobbering that would
 * destroy work in the name of restoring a default.
 */
test('backfill() never overwrites a file the worktree already has', async () => {
  const repo = tempRepo();
  const dest = bareWorktree(repo, 'lived-in');
  fs.writeFileSync(path.join(dest, '.env'), 'SECRET=edited-by-the-agent\n');

  const copied = await worktree.backfill(repo, dest, {
    copyPatterns: ['.env', 'config/*-config.ts'],
    copyAlways: ['.idea/runConfigurations/*.xml'],
  });
  assert.equal(
    fs.readFileSync(path.join(dest, '.env'), 'utf8'),
    'SECRET=edited-by-the-agent\n',
    "the agent's edit survived",
  );
  assert.equal(copied.files, 1, 'only the dev config was missing, so only it was counted');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('backfill() on a worktree that lacks nothing reports nothing, and is safe to re-run', async () => {
  const repo = tempRepo();
  const res = await worktree.create(repo, 'feature/complete', 'complete', {
    fetch: false,
    copyPatterns: ['.env', 'config/*-config.ts'],
  });
  const opts = { copyPatterns: ['.env', 'config/*-config.ts'], copyAlways: ['.idea/runConfigurations/*.xml'] };
  const first = await worktree.backfill(repo, res.path, opts);
  assert.deepEqual(first, { runConfigs: 0, files: 0 }, 'create() already brought everything');
  assert.deepEqual(await worktree.backfill(repo, res.path, opts), { runConfigs: 0, files: 0 }, 'idempotent');
  fs.rmSync(repo, { recursive: true, force: true });
});

// A tracked file arrives with the checkout; copying the main checkout's copy over it
// would import uncommitted edits. populate() has always made this distinction and
// backfill inherits it rather than restating it.
test('backfill() still refuses to copy tracked files', async () => {
  const repo = tempRepo();
  const dest = bareWorktree(repo, 'tracked');
  fs.writeFileSync(path.join(repo, 'README.md'), '# uncommitted edit in the main checkout\n');

  await worktree.backfill(repo, dest, { copyPatterns: ['README.md'], copyAlways: [] });
  assert.equal(
    fs.readFileSync(path.join(dest, 'README.md'), 'utf8'),
    '# repo\n',
    "the worktree keeps the committed content, not the checkout's uncommitted edit",
  );
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

/*
 * A NAME collision must not cost you the BRANCH you asked for.
 *
 * One loop tested `nameTaken || branchTaken` and, on either, rewrote both — so promoting
 * with a fresh unused branch under a name that happened to be taken silently created a
 * different branch. The only warning mentioned the name, so nothing connected the two,
 * and the branch you actually asked for was never used.
 */
test('a taken NAME suffixes the name and leaves the branch alone', async () => {
  const repo = plainRepo();
  await worktree.create(repo, 'feature/first', 'shared', { fetch: false, copyPatterns: [], unique: true });

  const res = await worktree.create(repo, 'feature/second', 'shared', {
    fetch: false,
    copyPatterns: [],
    unique: true,
  });
  expectOk(res, 'create()');
  assert.equal(res.branch, 'feature/second', 'the requested branch was free — it must be used');
  assert.equal(res.name, 'shared-2', 'only the name needed suffixing');
  assert.equal(await worktree.branchExists(repo, 'feature/second'), true);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a taken BRANCH suffixes the branch, and says so', async () => {
  const repo = plainRepo();
  await worktree.create(repo, 'feature/dup', 'one', { fetch: false, copyPatterns: [], unique: true });

  const res = await worktree.create(repo, 'feature/dup', 'two', {
    fetch: false,
    copyPatterns: [],
    unique: true,
  });
  const ok = expectOk(res, 'create()');
  assert.equal(ok.name, 'two', 'the name was free');
  assert.equal(ok.branch, 'feature/dup-2');
  assert.ok(
    (ok.warnings || []).some((w: string) => /branch "feature\/dup" already exists/.test(w)),
    `the branch substitution must be reported: ${JSON.stringify(ok.warnings)}`,
  );
  fs.rmSync(repo, { recursive: true, force: true });
});
