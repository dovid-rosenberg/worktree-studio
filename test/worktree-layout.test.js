// worktree.create() against the three configurable layouts, plus the
// copyAlways/copyPatterns split. Real git repos in a temp dir — the task's
// "use server/worktree.ts if a test needs a worktree" rule, so no `git worktree
// add` is ever run by hand.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import * as worktree from '../server/worktree.ts';
import * as layoutMod from '../server/layout.ts';
import * as gitMod from '../server/git.ts';
import * as config from '../server/config.ts';

function sh(cwd, cmd, args) { execFileSync(cmd, args, { cwd, stdio: 'ignore' }); }

// A repo inside its own container dir, so `sibling`/`external` layouts have
// somewhere sane to put things and the walk tests have a base dir to scan.
function repoIn(base, name, gitignore = '.worktrees/\n') {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 't@t.t']);
  sh(dir, 'git', ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), gitignore);
  sh(dir, 'git', ['add', '.']);
  sh(dir, 'git', ['commit', '-q', '-m', 'init']);
  return dir;
}

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// ------------------------------------------------------------------ layouts

test('the default layout still creates <repo>/.worktrees/<name>', async () => {
  const base = tmp('wts-nested-');
  const repo = repoIn(base, 'api');
  const res = await worktree.create(repo, 'feature/a', 'feat-a', { fetch: false, copyPatterns: [] });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.path, path.join(repo, '.worktrees', 'feat-a'));
  assert.ok(fs.existsSync(path.join(res.path, 'README.md')));
  // Pre-existing quirk, asserted so it stays pre-existing: `.gitignore` says
  // `.worktrees/`, a directory-only pattern, and check-ignore runs before the
  // directory exists — so the very first worktree in a repo warns. Unchanged.
  assert.deepEqual(res.warnings, ['.worktrees/ is not gitignored here; checkouts will show as untracked']);
  rm(base);
});

test('a nested layout with a custom dir creates <repo>/<dir>/<name>', async () => {
  const base = tmp('wts-nesteddir-');
  const repo = repoIn(base, 'api', 'wt/\n');
  fs.mkdirSync(path.join(repo, 'wt')); // so the directory-only ignore pattern matches
  const layout = layoutMod.resolve({ worktrees: { layout: 'nested', dir: 'wt' } });
  const res = await worktree.create(repo, 'feature/a', 'feat-a', { fetch: false, copyPatterns: [], layout });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.path, path.join(repo, 'wt', 'feat-a'));
  assert.deepEqual(res.warnings, [], 'the ignore check consults the CONFIGURED dir');
  rm(base);
});

test('the gitignore warning names the configured dir', async () => {
  const base = tmp('wts-warn-');
  const repo = repoIn(base, 'api', '# nothing ignored\n');
  const layout = layoutMod.resolve({ worktrees: { layout: 'nested', dir: 'wt' } });
  const res = await worktree.create(repo, 'feature/a', 'feat-a', { fetch: false, copyPatterns: [], layout });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.warnings, ['wt/ is not gitignored here; checkouts will show as untracked']);
  rm(base);
});

test('the sibling layout creates <repo>/../<name> and warns about nothing', async () => {
  const base = tmp('wts-sibling-');
  const repo = repoIn(base, 'api');
  const layout = layoutMod.resolve({ worktrees: { layout: 'sibling' } });
  const res = await worktree.create(repo, 'feature/a', 'feat-a', { fetch: false, copyPatterns: [], layout });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.path, path.join(base, 'feat-a'));
  assert.ok(fs.existsSync(path.join(res.path, 'README.md')), 'it is a real checkout');
  assert.deepEqual(res.warnings, [], 'outside the working tree — nothing to gitignore');
  rm(base);
});

test('the external layout creates <root>/<repo>/<name>, making the tree as it goes', async () => {
  const base = tmp('wts-external-');
  const repo = repoIn(base, 'api');
  const root = path.join(base, 'does', 'not', 'exist', 'yet');
  const layout = layoutMod.resolve({ worktrees: { layout: 'external', root } });
  const res = await worktree.create(repo, 'feature/a', 'feat-a', { fetch: false, copyPatterns: [], layout });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.path, path.join(root, 'api', 'feat-a'));
  assert.ok(fs.existsSync(path.join(res.path, 'README.md')));
  rm(base);
});

test('remove() works on a worktree created outside the repo', async () => {
  const base = tmp('wts-siblingrm-');
  const repo = repoIn(base, 'api');
  const layout = layoutMod.resolve({ worktrees: { layout: 'sibling' } });
  const res = await worktree.create(repo, 'feature/a', 'feat-a', { fetch: false, copyPatterns: [], layout });
  const out = await worktree.remove(repo, res.path);
  assert.equal(out.ok, true, out.error);
  assert.equal(fs.existsSync(res.path), false);
  rm(base);
});

test('the unique suffix walks the configured layout, not .worktrees', async () => {
  const base = tmp('wts-unique-');
  const repo = repoIn(base, 'api');
  const layout = layoutMod.resolve({ worktrees: { layout: 'sibling' } });
  const first = await worktree.create(repo, 'feature/dup', 'dup', { fetch: false, copyPatterns: [], layout, unique: true });
  const second = await worktree.create(repo, 'feature/dup', 'dup', { fetch: false, copyPatterns: [], layout, unique: true });
  assert.equal(first.path, path.join(base, 'dup'));
  assert.equal(second.ok, true, second.error);
  assert.equal(second.path, path.join(base, 'dup-2'), 'suffixed inside the sibling container');
  assert.equal(second.branch, 'feature/dup-2');
  rm(base);
});

// --------------------------------- the repo walk vs. an out-of-repo worktree

test('a sibling worktree is not scanned as a repo of its own', async () => {
  const base = tmp('wts-walk-');
  const repo = repoIn(base, 'api');
  const layout = layoutMod.resolve({ worktrees: { layout: 'sibling' } });
  const res = await worktree.create(repo, 'feature/a', 'feat-a', { fetch: false, copyPatterns: [], layout });
  assert.ok(fs.existsSync(res.path));
  const found = gitMod.findRepos([base], 2);
  assert.deepEqual(found, [repo], 'only the real repo — the worktree is reported through it');
  assert.equal(gitMod.isLinkedWorktree(res.path), true);
  assert.equal(gitMod.isLinkedWorktree(repo), false, 'a main checkout has a .git DIRECTORY');
  rm(base);
});

test('scan() still reports an out-of-repo worktree through its repo', async () => {
  const base = tmp('wts-scan-');
  const repo = repoIn(base, 'api');
  const layout = layoutMod.resolve({ worktrees: { layout: 'sibling' } });
  await worktree.create(repo, 'feature/a', 'feat-a', { fetch: false, copyPatterns: [], layout });
  const repos = await gitMod.scan([base], 2);
  assert.equal(repos.length, 1);
  assert.deepEqual(repos[0].worktrees.map((w) => w.name).sort(), ['api', 'feat-a']);
  rm(base);
});

// ------------------------------------------------- copyAlways / copyPatterns

function repoWithLocalFiles(base) {
  const repo = repoIn(base, 'api', '.worktrees/\n.env\n.env.local\n.vscode/\nconfig/*-config.ts\n');
  fs.writeFileSync(path.join(repo, '.env'), 'A=1\n');
  fs.writeFileSync(path.join(repo, '.env.local'), 'B=2\n');
  fs.mkdirSync(path.join(repo, '.vscode'));
  fs.writeFileSync(path.join(repo, '.vscode', 'settings.json'), '{}\n');
  fs.mkdirSync(path.join(repo, '.idea', 'runConfigurations'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.idea', 'runConfigurations', 'start.xml'), '<component/>\n');
  fs.writeFileSync(path.join(repo, 'tracked.json'), '{"tracked":true}\n');
  sh(repo, 'git', ['add', 'tracked.json']);
  sh(repo, 'git', ['commit', '-q', '-m', 'tracked']);
  return repo;
}

test('copyAlways defaults to the JetBrains run configs when the caller passes none', async () => {
  const base = tmp('wts-always-');
  const repo = repoWithLocalFiles(base);
  const res = await worktree.create(repo, 'feature/a', 'feat-a', { fetch: false, copyPatterns: [] });
  assert.equal(res.copied.runConfigs, 1, 'unchanged from the old hardcoded copy');
  assert.ok(fs.existsSync(path.join(res.path, '.idea', 'runConfigurations', 'start.xml')));
  rm(base);
});

test('copyAlways: [] turns the JetBrains copy off', async () => {
  const base = tmp('wts-always-off-');
  const repo = repoWithLocalFiles(base);
  const res = await worktree.create(repo, 'feature/a', 'feat-a', { fetch: false, copyPatterns: [], copyAlways: [] });
  assert.equal(res.copied.runConfigs, 0);
  assert.equal(fs.existsSync(path.join(res.path, '.idea')), false);
  rm(base);
});

test('copyAlways is not gated on gitignore (a tracked match is still copied)', async () => {
  const base = tmp('wts-always-tracked-');
  const repo = repoWithLocalFiles(base);
  const res = await worktree.create(repo, 'feature/a', 'feat-a', {
    fetch: false, copyPatterns: [], copyAlways: ['tracked.json'],
  });
  assert.equal(res.copied.runConfigs, 1);
  rm(base);
});

test('the shipped copyPatterns carry .env* and gitignored .vscode json', async () => {
  const base = tmp('wts-patterns-');
  const repo = repoWithLocalFiles(base);
  const cfg = config.defaults();
  const res = await worktree.create(repo, 'feature/a', 'feat-a', {
    fetch: false, ...worktree.worktreeCopyOpts(cfg, 'api'),
  });
  for (const rel of ['.env', '.env.local', path.join('.vscode', 'settings.json')]) {
    assert.ok(fs.existsSync(path.join(res.path, rel)), `${rel} not copied`);
  }
  assert.ok(fs.existsSync(path.join(res.path, '.idea', 'runConfigurations', 'start.xml')), 'run config still copied');
  rm(base);
});

test('copyPatterns never copies a TRACKED match over the checkout', async () => {
  const base = tmp('wts-tracked-');
  const repo = repoWithLocalFiles(base);
  // dirty the tracked file in the main checkout; the worktree must get the committed one
  fs.writeFileSync(path.join(repo, 'tracked.json'), '{"dirty":true}\n');
  const res = await worktree.create(repo, 'feature/a', 'feat-a', {
    fetch: false, copyPatterns: ['tracked.json'], copyAlways: [],
  });
  assert.equal(res.copied.files, 0, 'a tracked file is skipped');
  assert.equal(fs.readFileSync(path.join(res.path, 'tracked.json'), 'utf8'), '{"tracked":true}\n');
  rm(base);
});

test('worktreeCopyOpts prefers a per-repo override and keeps the copyAlways default', () => {
  const cfg = { copyPatterns: { default: ['.env'], api: ['only-here'] } };
  assert.deepEqual(worktree.worktreeCopyOpts(cfg, 'api'), {
    copyPatterns: ['only-here'],
    copyAlways: worktree.DEFAULT_COPY_ALWAYS,
  });
  assert.deepEqual(worktree.worktreeCopyOpts(cfg, 'other').copyPatterns, ['.env']);
});

test('worktreeCopyOpts obeys an explicit copyAlways, empty included', () => {
  assert.deepEqual(worktree.worktreeCopyOpts({ copyAlways: { default: [] } }, 'api').copyAlways, []);
  assert.deepEqual(worktree.worktreeCopyOpts({ copyAlways: { api: ['x'] } }, 'api').copyAlways, ['x']);
});
