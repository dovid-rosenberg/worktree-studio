import { test } from 'node:test';
import assert from 'node:assert';
import { computeFeatures, resolveRef } from '../server/features.ts';
import { present } from './helpers.ts';
import type { FeatureMember, Worktree } from '../server/types.ts';

// A worktree row, spelling only what computeFeatures() reads: repo/wtname decide
// whether it is a main checkout, branch feeds the `branch` identity strategy, and
// `running` is what orders the result. The rest of `Worktree` is irrelevant here, so
// the fixture is typed by the slice rather than filled with placeholder values.
type WtFixture = Pick<Worktree, 'repo' | 'wtname' | 'branch' | 'path' | 'running'>;
function wt(repo: string, wtname: string, branch: string | null, extra: Partial<WtFixture> = {}): Worktree {
  return {
    repo,
    wtname,
    branch,
    path: `/r/${repo}/.worktrees/${wtname}`,
    running: false,
    ...extra,
  } as Worktree;
}

/** A member the test placed there itself, so it is a real worktree and not a stub. */
function real(m: FeatureMember | undefined): Worktree {
  const x = present(m, 'group member');
  if (x.missing) throw new Error(`expected a real worktree, got the missing stub ${x.ref}`);
  return x;
}

test('auto-groups worktrees sharing a name across repos; singles are features but not groups', () => {
  const worktrees = [
    wt('accept-blue', 'accept-blue', 'develop'), // main checkout — never a feature
    wt('accept-blue', 'recurring-pm', 'fix/recurring'),
    wt('merchant-v3', 'merchant-v3', 'main'), // main checkout
    wt('merchant-v3', 'recurring-pm', 'fix/recurring-ux'),
    wt('accept-blue', 'invoice-order', 'fix/invoice'), // single
  ];
  const { features, groups } = computeFeatures(worktrees, []);
  const rec = features.find((f) => f.name === 'recurring-pm');
  assert.ok(rec, 'recurring-pm is a feature');
  assert.equal(rec.members.length, 2, 'recurring-pm spans 2 repos');
  assert.ok(
    features.find((f) => f.name === 'invoice-order'),
    'single is a feature',
  );
  // main checkouts are never features
  assert.ok(!features.find((f) => f.name === 'accept-blue'));
  // groups only include the multi-member one
  assert.deepEqual(groups.map((g) => g.name).sort(), ['recurring-pm']);
});

test('manual group resolves members by wtname OR branch and marks missing', () => {
  const worktrees = [wt('accept-blue', 'wt-a', 'feature/alpha'), wt('merchant-v3', 'wt-b', 'feature/alpha')];
  const manual = [
    { name: 'Alpha', members: ['accept-blue/wt-a', 'merchant-v3/feature/alpha', 'ghost/nope'] },
  ];
  const { features } = computeFeatures(worktrees, manual);
  const g = features.find((f) => f.name === 'Alpha');
  assert.ok(g && g.auto === false);
  assert.equal(real(g.members[0]).wtname, 'wt-a'); // by wtname
  assert.equal(real(g.members[1]).branch, 'feature/alpha'); // by branch
  assert.equal(present(g.members[2]).missing, true); // unresolved
});

test('manual group name suppresses the auto feature of the same name', () => {
  const worktrees = [wt('a', 'shared', 'x'), wt('b', 'shared', 'y')];
  const manual = [{ name: 'shared', members: ['a/shared'] }];
  const { features, groups } = computeFeatures(worktrees, manual);
  // only the manual 'shared' remains, not an auto duplicate
  assert.equal(features.filter((f) => f.name === 'shared').length, 1);
  assert.equal(
    present(
      features.find((f) => f.name === 'shared'),
      "the 'shared' feature",
    ).auto,
    false,
  );
  assert.equal(groups.filter((g) => g.name === 'shared').length, 1);
});

test('resolveRef returns a missing stub for unknown refs', () => {
  assert.deepEqual(resolveRef([], 'x/y'), { missing: true, ref: 'x/y' });
});

/*
 * A worktree claimed by a manual group must not ALSO be its own singleton feature.
 *
 * The dedupe compared the auto-identity against manual group NAMES, which never match a
 * member's basename — so `{name:'mixed', members:['api/alpha','web/beta']}` produced
 * `mixed` and `alpha` and `beta`: three cards, each independently startable, each taking
 * its own concurrency slot. Under the `manifest` strategy the identities happen to
 * collapse to the group name and the name test appears to work, which is what hid it for
 * the one strategy anybody exercised.
 */
test('members of a manual group do not reappear as singleton features', () => {
  const worktrees = [
    wt('api', 'alpha', 'feature/alpha'),
    wt('web', 'beta', 'feature/beta'),
    wt('worker', 'gamma', 'feature/gamma'),
    wt('other', 'unrelated', 'feature/unrelated'),
  ];
  const groups = [{ name: 'mixed', members: ['api/alpha', 'web/beta', 'worker/gamma'] }];

  const { features } = computeFeatures(worktrees, groups);
  const names = features.map((f) => f.name).sort();

  assert.deepEqual(names, ['mixed', 'unrelated'], 'alpha/beta/gamma belong to mixed, not to themselves');
  assert.equal(
    present(
      features.find((f) => f.name === 'mixed'),
      'mixed',
    ).members.length,
    3,
  );
});

test('a worktree NOT in any group is still its own feature', () => {
  // The guard is scoped to claimed paths, so everything else is untouched.
  const worktrees = [wt('api', 'solo', 'feature/solo')];
  const { features } = computeFeatures(worktrees, [{ name: 'empty-ish', members: ['api/nope'] }]);
  assert.ok(features.some((f) => f.name === 'solo'));
});
