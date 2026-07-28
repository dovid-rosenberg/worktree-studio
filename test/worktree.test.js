import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import * as worktree from '../server/worktree.js';

function sh(cwd, cmd, args) { execFileSync(cmd, args, { cwd, stdio: 'ignore' }); }

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-repo-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 't@t.t']);
  sh(dir, 'git', ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  // a gitignored local config + run config that must be carried into worktrees
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n.worktrees/\nconfig/*-config.js\n');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'dev-config.js'), 'module.exports={};\n');
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
    copyPatterns: ['.env', 'config/*-config.js'],
  });
  assert.equal(res.ok, true, res.error);
  assert.ok(fs.existsSync(res.path), 'worktree dir exists');
  assert.ok(fs.existsSync(path.join(res.path, '.env')), '.env copied');
  assert.ok(fs.existsSync(path.join(res.path, 'config', 'dev-config.js')), 'dev-config.js copied');
  assert.ok(fs.existsSync(path.join(res.path, '.idea', 'runConfigurations', 'start.xml')), 'run config copied');
  assert.equal(res.copied.runConfigs, 1);
  assert.equal(res.copied.files, 2);
  assert.equal(res.created, true);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('create() refuses a duplicate worktree name', async () => {
  const repo = tempRepo();
  await worktree.create(repo, 'feature/foo', 'dup', { fetch: false, copyPatterns: [] });
  const again = await worktree.create(repo, 'feature/bar', 'dup', { fetch: false, copyPatterns: [] });
  assert.equal(again.ok, false);
  assert.match(again.error, /already exists/);
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
  assert.equal(out.ok, true, out.error);
  assert.equal(fs.existsSync(res.path), false, 'worktree dir removed');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('remove() with { deleteBranch } also deletes the branch', async () => {
  const repo = plainRepo();
  const res = await worktree.create(repo, 'feature/gone2', 'gone2', { fetch: false, copyPatterns: [] });
  assert.equal(await worktree.branchExists(repo, 'feature/gone2'), true, 'branch exists before remove');
  const out = await worktree.remove(repo, res.path, { deleteBranch: true, branch: 'feature/gone2' });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.branchDeleted, true, 'branch reported deleted');
  assert.equal(await worktree.branchExists(repo, 'feature/gone2'), false, 'branch is gone');
  fs.rmSync(repo, { recursive: true, force: true });
});
