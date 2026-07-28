// server/layout.ts — where worktrees live. The default must reproduce the
// `.worktrees/<name>` convention that used to be a literal in four files.
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import * as layout from '../server/layout.ts';

const nested = layout.resolve({});

// ---- defaults ----

test('resolve() with no config is the nested .worktrees layout', () => {
  assert.deepEqual(nested, { mode: 'nested', dir: '.worktrees', root: '' });
});

test('destFor() default reproduces <repo>/.worktrees/<name> exactly', () => {
  assert.equal(layout.destFor(nested, '/code/api', 'feat-a'), '/code/api/.worktrees/feat-a');
});

test('ignorePath() default is .worktrees (what the gitignore warning checks)', () => {
  assert.equal(layout.ignorePath(nested), '.worktrees');
});

test('containerFor() default is <repo>/.worktrees', () => {
  assert.equal(layout.containerFor(nested, '/code/api'), '/code/api/.worktrees');
});

// ---- nameFromPath: byte-identical to the old featureFromPath() ----

test('nameFromPath() takes the segment after .worktrees', () => {
  assert.equal(layout.nameFromPath(nested, '/code/api/.worktrees/feat-a'), 'feat-a');
});

test('nameFromPath() resolves a path INSIDE a worktree to the worktree', () => {
  assert.equal(layout.nameFromPath(nested, '/code/api/.worktrees/feat-a/src/deep'), 'feat-a');
});

test('nameFromPath() falls back to basename for a main checkout (no .worktrees segment)', () => {
  assert.equal(layout.nameFromPath(nested, '/code/api'), 'api');
});

test('nameFromPath() uses the LAST .worktrees segment (worktree of a worktree)', () => {
  assert.equal(layout.nameFromPath(nested, '/code/api/.worktrees/a/.worktrees/b'), 'b');
});

test('nameFromPath() with a trailing .worktrees segment falls back to basename', () => {
  assert.equal(layout.nameFromPath(nested, '/code/api/.worktrees'), '.worktrees');
});

test('nameFromPath() handles empty/undefined input', () => {
  assert.equal(layout.nameFromPath(nested, ''), '');
  assert.equal(layout.nameFromPath(nested, undefined), '');
});

// ---- nested with a custom dir ----

test('nested honours a custom worktrees.dir', () => {
  const l = layout.resolve({ worktrees: { layout: 'nested', dir: 'wt' } });
  assert.equal(layout.destFor(l, '/code/api', 'feat-a'), '/code/api/wt/feat-a');
  assert.equal(layout.nameFromPath(l, '/code/api/wt/feat-a/src'), 'feat-a');
  assert.equal(layout.ignorePath(l), 'wt');
});

test('nested supports a multi-segment dir', () => {
  const l = layout.resolve({ worktrees: { layout: 'nested', dir: '.git/wt' } });
  assert.equal(layout.destFor(l, '/code/api', 'x'), '/code/api/.git/wt/x');
  assert.equal(layout.nameFromPath(l, '/code/api/.git/wt/x/sub'), 'x');
});

test('resolve() strips stray slashes from dir', () => {
  assert.equal(layout.resolve({ worktrees: { dir: '/wt/' } }).dir, 'wt');
  assert.equal(layout.resolve({ worktrees: { dir: '///' } }).dir, '.worktrees');
});

// ---- sibling ----

test('sibling puts the worktree beside the repo', () => {
  const l = layout.resolve({ worktrees: { layout: 'sibling' } });
  assert.equal(layout.destFor(l, '/code/api', 'feat-a'), '/code/feat-a');
  assert.equal(layout.containerFor(l, '/code/api'), '/code');
});

test('sibling names a worktree by its basename and has nothing to gitignore', () => {
  const l = layout.resolve({ worktrees: { layout: 'sibling' } });
  assert.equal(layout.nameFromPath(l, '/code/feat-a'), 'feat-a');
  assert.equal(layout.ignorePath(l), null);
});

// ---- external ----

test('external puts worktrees under <root>/<repo>/<name>', () => {
  const l = layout.resolve({ worktrees: { layout: 'external', root: '/wt' } });
  assert.equal(layout.destFor(l, '/code/api', 'feat-a'), '/wt/api/feat-a');
  assert.equal(layout.nameFromPath(l, '/wt/api/feat-a'), 'feat-a');
  assert.equal(layout.ignorePath(l), null);
});

test('external expands ~ in root', () => {
  const l = layout.resolve({ worktrees: { layout: 'external', root: '~/wt' } });
  assert.ok(l.root.startsWith(os.homedir()));
  assert.ok(!l.root.includes('~'));
});

// ---- bad config never throws; it degrades to today's behavior ----

test('an unknown layout falls back to nested', () => {
  // A value outside the union on purpose — this test IS the bad-config case, so the
  // cast is what lets it hand resolve() something a caller could still put in config.json.
  assert.equal(layout.resolve({ worktrees: { layout: 'sideways' as 'nested' } }).mode, 'nested');
});

test('external without a root falls back to nested', () => {
  const l = layout.resolve({ worktrees: { layout: 'external' } });
  assert.equal(l.mode, 'nested');
  assert.equal(layout.destFor(l, '/code/api', 'x'), '/code/api/.worktrees/x');
});
