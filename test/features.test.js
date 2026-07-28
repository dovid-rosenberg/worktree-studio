import { test } from 'node:test';
import assert from 'node:assert';
import { computeFeatures, resolveRef } from '../server/features.js';

// helper worktree
function wt(repo, wtname, branch, extra = {}) {
  return { repo, wtname, branch, path: `/r/${repo}/.worktrees/${wtname}`, running: false, ...extra };
}

test('auto-groups worktrees sharing a name across repos; singles are features but not groups', () => {
  const worktrees = [
    wt('accept-blue', 'accept-blue', 'develop'),   // main checkout — never a feature
    wt('accept-blue', 'recurring-pm', 'fix/recurring'),
    wt('merchant-v3', 'merchant-v3', 'main'),       // main checkout
    wt('merchant-v3', 'recurring-pm', 'fix/recurring-ux'),
    wt('accept-blue', 'invoice-order', 'fix/invoice'), // single
  ];
  const { features, groups } = computeFeatures(worktrees, []);
  const rec = features.find((f) => f.name === 'recurring-pm');
  assert.ok(rec, 'recurring-pm is a feature');
  assert.equal(rec.members.length, 2, 'recurring-pm spans 2 repos');
  assert.ok(features.find((f) => f.name === 'invoice-order'), 'single is a feature');
  // main checkouts are never features
  assert.ok(!features.find((f) => f.name === 'accept-blue'));
  // groups only include the multi-member one
  assert.deepEqual(groups.map((g) => g.name).sort(), ['recurring-pm']);
});

test('manual group resolves members by wtname OR branch and marks missing', () => {
  const worktrees = [
    wt('accept-blue', 'wt-a', 'feature/alpha'),
    wt('merchant-v3', 'wt-b', 'feature/alpha'),
  ];
  const manual = [{ name: 'Alpha', members: ['accept-blue/wt-a', 'merchant-v3/feature/alpha', 'ghost/nope'] }];
  const { features } = computeFeatures(worktrees, manual);
  const g = features.find((f) => f.name === 'Alpha');
  assert.ok(g && g.auto === false);
  assert.equal(g.members[0].wtname, 'wt-a');          // by wtname
  assert.equal(g.members[1].branch, 'feature/alpha'); // by branch
  assert.equal(g.members[2].missing, true);           // unresolved
});

test('manual group name suppresses the auto feature of the same name', () => {
  const worktrees = [wt('a', 'shared', 'x'), wt('b', 'shared', 'y')];
  const manual = [{ name: 'shared', members: ['a/shared'] }];
  const { features, groups } = computeFeatures(worktrees, manual);
  // only the manual 'shared' remains, not an auto duplicate
  assert.equal(features.filter((f) => f.name === 'shared').length, 1);
  assert.equal(features.find((f) => f.name === 'shared').auto, false);
  assert.equal(groups.filter((g) => g.name === 'shared').length, 1);
});

test('resolveRef returns a missing stub for unknown refs', () => {
  assert.deepEqual(resolveRef([], 'x/y'), { missing: true, ref: 'x/y' });
});
