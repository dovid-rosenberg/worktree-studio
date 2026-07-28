'use strict';
// server/identity.js — the pluggable "which worktrees are the same feature?"
// strategy. The properties that matter most here are (a) `basename` is
// byte-identical to the old behavior and (b) of() and ofPath() never disagree,
// because a feature grouped one way and slotted another collides on ports.
const { test } = require('node:test');
const assert = require('node:assert');
const { createIdentity, compileBranchMatcher, firstCapture } = require('../server/identity');
const { computeFeatures } = require('../server/features');
const { featureFromPath } = require('../server/servers');

const wt = (repo, wtname, branch) => ({ repo, wtname, branch, path: `/r/${repo}/.worktrees/${wtname}`, running: false });

// A scan-shaped repo list, as server/git.js emits it (worktrees carry `name`).
const scan = (worktrees) => {
  const byRepo = new Map();
  for (const w of worktrees) {
    if (!byRepo.has(w.repo)) byRepo.set(w.repo, { name: w.repo, worktrees: [] });
    byRepo.get(w.repo).worktrees.push({ path: w.path, name: w.wtname, branch: w.branch });
  }
  return [...byRepo.values()];
};

// ---------------------------------------------------------------- basename

test('basename is the default strategy', () => {
  assert.equal(createIdentity({}).strategy, 'basename');
  assert.equal(createIdentity().strategy, 'basename');
});

test('basename returns the worktree name, ignoring the branch entirely', () => {
  const id = createIdentity({});
  assert.equal(id.of(wt('api', 'feat-a', 'feature/totally-different')), 'feat-a');
});

test('basename ofPath() equals the old featureFromPath() for every shape of path', () => {
  const id = createIdentity({});
  const paths = [
    '/code/api/.worktrees/feat-a',
    '/code/api/.worktrees/feat-a/src/deep',
    '/code/api',                      // main checkout
    '/code/api/.worktrees',           // degenerate
    '/code/api/.worktrees/a/.worktrees/b',
    '',
  ];
  for (const p of paths) assert.equal(id.ofPath(p), featureFromPath(p), `differs for ${p}`);
});

test('basename ofPath() still equals featureFromPath() after the index is fed', () => {
  const id = createIdentity({});
  const worktrees = [wt('api', 'feat-a', 'fix/123-a'), wt('fe', 'feat-a', 'feat/123-b')];
  id.reindex(scan(worktrees));
  for (const w of worktrees) assert.equal(id.ofPath(w.path), featureFromPath(w.path));
});

test('basename of() and ofPath() agree for indexed and unindexed worktrees', () => {
  const id = createIdentity({});
  const worktrees = [wt('api', 'shared', 'fix/1'), wt('fe', 'shared', 'feat/2')];
  id.reindex(scan(worktrees));
  for (const w of worktrees) assert.equal(id.of(w), id.ofPath(w.path));
});

test('computeFeatures with the default identity is unchanged from grouping on wtname', () => {
  const worktrees = [wt('api', 'api', 'main'), wt('api', 'shared', 'x'), wt('fe', 'shared', 'y'), wt('api', 'solo', 'z')];
  const before = computeFeatures(worktrees, []);
  const after = computeFeatures(worktrees, [], createIdentity({}));
  assert.deepEqual(after.features.map((f) => f.name), before.features.map((f) => f.name));
  assert.deepEqual(after.groups.map((g) => g.name), before.groups.map((g) => g.name));
});

// ------------------------------------------------------------------ branch

const BRANCH_CFG = { featureIdentity: { strategy: 'branch', branchPattern: '^(?:fix|feat)/(\\d+)-' } };

test('branch groups two differently-named worktrees that share a ticket number', () => {
  const id = createIdentity(BRANCH_CFG);
  assert.equal(id.strategy, 'branch');
  assert.equal(id.of(wt('api', 'payment-fix', 'fix/123-payment')), '123');
  assert.equal(id.of(wt('fe', 'payment-ui', 'feat/123-ui')), '123');
});

test('branch makes computeFeatures group across repos despite different basenames', () => {
  const id = createIdentity(BRANCH_CFG);
  const worktrees = [wt('api', 'payment-fix', 'fix/123-payment'), wt('fe', 'payment-ui', 'feat/123-ui')];
  const { features, groups } = computeFeatures(worktrees, [], id);
  const f = features.find((x) => x.name === '123');
  assert.ok(f, 'the ticket number is the feature');
  assert.equal(f.members.length, 2);
  assert.deepEqual(groups.map((g) => g.name), ['123'], 'and it is a real multi-repo group');
});

test('branch ofPath() agrees with of() once the index is fed', () => {
  const id = createIdentity(BRANCH_CFG);
  const worktrees = [wt('api', 'payment-fix', 'fix/123-payment'), wt('fe', 'payment-ui', 'feat/123-ui')];
  id.reindex(scan(worktrees));
  for (const w of worktrees) assert.equal(id.ofPath(w.path), id.of(w), `disagreement for ${w.path}`);
  assert.equal(id.ofPath(worktrees[0].path), '123');
  assert.equal(id.ofPath(worktrees[1].path), '123');
});

test('branch: an unindexed path degrades to the layout name, never throws', () => {
  const id = createIdentity(BRANCH_CFG);
  assert.equal(id.ofPath('/code/api/.worktrees/never-scanned'), 'never-scanned');
});

test('branch: a branch that does not match falls back to the worktree name', () => {
  const id = createIdentity(BRANCH_CFG);
  assert.equal(id.of(wt('api', 'chore-cleanup', 'chore/cleanup')), 'chore-cleanup');
});

test('branch: a worktree with no branch (detached) falls back to the worktree name', () => {
  const id = createIdentity(BRANCH_CFG);
  assert.equal(id.of({ repo: 'api', wtname: 'detached-wt', branch: null, path: '/r/api/.worktrees/detached-wt' }), 'detached-wt');
});

test('branch: reindex() drops a worktree that no longer exists', () => {
  const id = createIdentity(BRANCH_CFG);
  const a = wt('api', 'payment-fix', 'fix/123-payment');
  id.reindex(scan([a]));
  assert.equal(id.ofPath(a.path), '123');
  id.reindex([]);
  assert.equal(id.ofPath(a.path), 'payment-fix', 'falls back to the layout name once unindexed');
});

test('branch: multiple capture groups use the leftmost that captured', () => {
  const id = createIdentity({ featureIdentity: { strategy: 'branch', branchPattern: '^(?:fix|feat)/(\\d+)-(.*)$' } });
  assert.equal(id.of(wt('api', 'x', 'fix/123-payment')), '123');
});

test('branch: an alternation where the first group misses uses the second', () => {
  const id = createIdentity({ featureIdentity: { strategy: 'branch', branchPattern: '^(?:(?:JIRA-(\\d+))|(?:TICKET-(\\d+)))' } });
  assert.equal(id.of(wt('api', 'x', 'JIRA-7-thing')), '7');
  assert.equal(id.of(wt('api', 'x', 'TICKET-9-thing')), '9');
});

test('branch: a g flag does not make matching stateful', () => {
  const id = createIdentity({ featureIdentity: { strategy: 'branch', branchPattern: '(\\d+)', branchFlags: 'g' } });
  const w = wt('api', 'x', 'fix/42-a');
  assert.equal(id.of(w), '42');
  assert.equal(id.of(w), '42', 'a second call returns the same answer');
  assert.equal(id.of(w), '42');
});

test('branch: branchFlags are honoured (case-insensitive)', () => {
  const id = createIdentity({ featureIdentity: { strategy: 'branch', branchPattern: '^ab-(\\d+)', branchFlags: 'i' } });
  assert.equal(id.of(wt('api', 'x', 'AB-55-thing')), '55');
});

// --------------------------------------------------- invalid configuration

test('an invalid regex does not throw and falls back to basename', () => {
  const id = createIdentity({ featureIdentity: { strategy: 'branch', branchPattern: '([unclosed' } });
  assert.equal(id.strategy, 'basename');
  assert.ok(id.warning && /falling back/.test(id.warning));
  assert.equal(id.of(wt('api', 'feat-a', 'fix/1-x')), 'feat-a');
});

test('a pattern with no capture group falls back to basename rather than matching nothing', () => {
  const id = createIdentity({ featureIdentity: { strategy: 'branch', branchPattern: '^fix/\\d+' } });
  assert.equal(id.strategy, 'basename');
  assert.ok(/no capture group/.test(id.warning));
});

test('an empty branchPattern falls back to basename', () => {
  const id = createIdentity({ featureIdentity: { strategy: 'branch' } });
  assert.equal(id.strategy, 'basename');
});

test('an unknown strategy falls back to basename', () => {
  const id = createIdentity({ featureIdentity: { strategy: 'astrology' } });
  assert.equal(id.strategy, 'basename');
  assert.ok(/astrology/.test(id.warning));
});

test('compileBranchMatcher reports the regex error instead of throwing', () => {
  assert.ok(compileBranchMatcher('([', '').error);
  assert.ok(compileBranchMatcher('', '').error);
  assert.ok(compileBranchMatcher('abc', '').error);       // no group
  assert.ok(compileBranchMatcher('a[(]b(c)', '').re);     // a paren in a class is not a group
  assert.ok(compileBranchMatcher('\\((x)', '').re);       // an escaped paren is not a group
  assert.ok(compileBranchMatcher('(?:a)', '').error);     // non-capturing only
});

test('firstCapture skips undefined and empty groups', () => {
  assert.equal(firstCapture(null), null);
  assert.equal(firstCapture(['whole', undefined, 'b']), 'b');
  assert.equal(firstCapture(['whole', '', 'b']), 'b');
  assert.equal(firstCapture(['whole']), null);
});

// ---------------------------------------------------------------- manifest

const MANIFEST_CFG = {
  featureIdentity: { strategy: 'manifest' },
  groups: [{ name: 'Alpha', members: ['api/wt-a', 'fe/feature/alpha'] }],
};

test('manifest reads the EXISTING config.groups — no second config key', () => {
  const id = createIdentity(MANIFEST_CFG);
  assert.equal(id.strategy, 'manifest');
  assert.equal(id.of(wt('api', 'wt-a', 'feature/alpha')), 'Alpha', 'matched by repo/wtname');
  assert.equal(id.of(wt('fe', 'wt-b', 'feature/alpha')), 'Alpha', 'matched by repo/branch');
});

test('manifest gives an unlisted worktree its own name', () => {
  const id = createIdentity(MANIFEST_CFG);
  assert.equal(id.of(wt('api', 'unlisted', 'x')), 'unlisted');
});

test('manifest makes slot keying agree with the manual group (the bug basename has)', () => {
  const id = createIdentity(MANIFEST_CFG);
  const worktrees = [wt('api', 'wt-a', 'feature/alpha'), wt('fe', 'wt-b', 'feature/alpha')];
  id.reindex(scan(worktrees));
  // Under `basename` these two get a slot each and collide; under `manifest` they share one.
  assert.equal(id.ofPath(worktrees[0].path), 'Alpha');
  assert.equal(id.ofPath(worktrees[1].path), 'Alpha');
  const { features } = computeFeatures(worktrees, MANIFEST_CFG.groups, id);
  const alpha = features.find((f) => f.name === 'Alpha');
  assert.ok(alpha && alpha.members.length === 2);
  assert.equal(features.filter((f) => f.name === 'Alpha').length, 1, 'no duplicate auto feature');
});

test('manifest with no groups configured behaves exactly like basename', () => {
  const id = createIdentity({ featureIdentity: { strategy: 'manifest' } });
  const w = wt('api', 'feat-a', 'fix/1-x');
  assert.equal(id.of(w), 'feat-a');
  assert.equal(id.ofPath(w.path), featureFromPath(w.path));
});

// ------------------------------------------------------------ layout combo

test('identity follows a non-default worktree layout', () => {
  const id = createIdentity({ worktrees: { layout: 'sibling' } });
  assert.equal(id.layout.mode, 'sibling');
  assert.equal(id.ofPath('/code/feat-a'), 'feat-a');
  assert.equal(id.of({ repo: 'api', path: '/code/feat-a' }), 'feat-a', 'derives the name when wtname is absent');
});
