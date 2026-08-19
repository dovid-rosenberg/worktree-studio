import test from 'node:test';
import assert from 'node:assert/strict';
import { attachableWorktrees, detectSessionRepoGaps } from '../server/features.ts';

/*
 * Reconciling a session's repos against its feature's worktrees.
 *
 * The bug this exists for: a feature groups worktrees by identity, a session's `repos`
 * is what the agent was granted with /add-dir, and nothing kept the two in step. Three
 * worktrees made with a plain `wt`, then a session promoted into the same name, and the
 * feature card showed four repos while the session knew one. Changes is session-scoped,
 * so it rendered an empty diff of a genuinely empty worktree — which reads as "no
 * changes" rather than as "you are looking at the wrong repo".
 */

const wt = (name: string, path: string, over: Record<string, unknown> = {}) => ({
  name,
  path,
  branch: `fix/${name}`,
  isMain: false,
  ...over,
});

/** Four repos, one feature name, main checkouts included as they are in a real scan. */
const scan = () => [
  {
    name: 'accept-blue',
    path: '/r/accept-blue',
    worktrees: [
      wt('accept-blue', '/r/accept-blue', { isMain: true }),
      wt('feat-x', '/r/accept-blue/.worktrees/feat-x'),
    ],
  },
  {
    name: 'merchant-v3',
    path: '/r/merchant-v3',
    worktrees: [
      wt('merchant-v3', '/r/merchant-v3', { isMain: true }),
      wt('feat-x', '/r/merchant-v3/.worktrees/feat-x'),
    ],
  },
  {
    name: 'ab-libraries',
    path: '/r/ab-libraries',
    worktrees: [
      wt('ab-libraries', '/r/ab-libraries', { isMain: true }),
      wt('feat-x', '/r/ab-libraries/.worktrees/feat-x'),
    ],
  },
  {
    name: 'other',
    path: '/r/other',
    worktrees: [wt('other', '/r/other', { isMain: true }), wt('unrelated', '/r/other/.worktrees/unrelated')],
  },
];

/** Basename identity: the worktree dir name IS the feature. */
const byName = (i: { wtname?: string }) => i.wtname ?? '';

test('finds the feature worktrees the session has no record of', () => {
  const out = attachableWorktrees(scan(), 'feat-x', new Set(['/r/accept-blue']), byName);
  assert.deepEqual(
    out.map((o) => o.repo),
    ['merchant-v3', 'ab-libraries'],
  );
  assert.equal(out[0].worktreePath, '/r/merchant-v3/.worktrees/feat-x');
  assert.equal(out[0].branch, 'fix/feat-x');
});

test('skips repos the session already has — attaching twice is not the fix', () => {
  const known = new Set(['/r/accept-blue', '/r/merchant-v3', '/r/ab-libraries']);
  assert.deepEqual(attachableWorktrees(scan(), 'feat-x', known, byName), []);
});

test('ignores worktrees belonging to a different feature', () => {
  const out = attachableWorktrees(scan(), 'feat-x', new Set(), byName);
  assert.ok(!out.some((o) => o.repo === 'other'), 'an unrelated worktree is not this feature');
});

test('never offers a main checkout — a feature member is a linked worktree', () => {
  // Main checkouts are in the scan and share the repo name; without the isMain guard
  // an identity strategy keying on something else could match one and offer to attach
  // the user's main working copy.
  const out = attachableWorktrees(scan(), 'accept-blue', new Set(), byName);
  assert.deepEqual(out, []);
});

test('a session with no feature yet has nothing to reconcile against', () => {
  assert.deepEqual(attachableWorktrees(scan(), null, new Set(), byName), []);
  assert.deepEqual(attachableWorktrees(scan(), undefined, new Set(), byName), []);
});

test('asks the identity resolver rather than comparing names', () => {
  // The whole point of routing through of(): under `branch` or `manifest` the worktree
  // dir name is NOT the feature, and a basename comparison would silently find nothing.
  const byBranch = (i: { branch?: string | null }) => (i.branch || '').replace(/^fix\//, '');
  const out = attachableWorktrees(scan(), 'feat-x', new Set(['/r/accept-blue']), byBranch);
  assert.deepEqual(
    out.map((o) => o.repo),
    ['merchant-v3', 'ab-libraries'],
  );
});

/*
 * detectSessionRepoGaps(): the same reconciliation, asked on every scan.
 *
 * Promote was the only moment that ever asked, so a session ADOPTED into an existing
 * feature — or one whose sibling worktree was cut later with a plain `wt` — kept a repo
 * list that was quietly short, and the only symptom was an empty Changes diff.
 */

const sess = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  title: 'feat-x work',
  feature: 'feat-x',
  active: true,
  repos: [{ repoPath: '/r/accept-blue' }],
  ...over,
});

test('a session whose repos are a strict subset of its feature is detected', () => {
  const gaps = detectSessionRepoGaps([sess()], scan(), byName);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].sessionId, 's1');
  assert.equal(gaps[0].feature, 'feat-x');
  assert.deepEqual(
    gaps[0].missing.map((m) => m.repo),
    ['merchant-v3', 'ab-libraries'],
  );
  // Enough to attach with, not just enough to name — the offer and the action must
  // describe the same worktree.
  assert.equal(gaps[0].missing[0].worktreePath, '/r/merchant-v3/.worktrees/feat-x');
  assert.equal(gaps[0].missing[0].repoPath, '/r/merchant-v3');
});

test('an equal set is not a gap — the records agree', () => {
  const repos = [
    { repoPath: '/r/accept-blue' },
    { repoPath: '/r/merchant-v3' },
    { repoPath: '/r/ab-libraries' },
  ];
  assert.deepEqual(detectSessionRepoGaps([sess({ repos })], scan(), byName), []);
});

test('a session with no feature has nothing to reconcile against', () => {
  assert.deepEqual(detectSessionRepoGaps([sess({ feature: '' })], scan(), byName), []);
  assert.deepEqual(detectSessionRepoGaps([sess({ feature: null })], scan(), byName), []);
});

test('a deactivated session is not offered — there is no agent to /add-dir into', () => {
  assert.deepEqual(detectSessionRepoGaps([sess({ active: false })], scan(), byName), []);
  // …but a row that simply does not carry the field is still examined, or a caller
  // handing over trimmed sessions would silently see no gaps at all.
  assert.equal(detectSessionRepoGaps([sess({ active: undefined })], scan(), byName).length, 1);
});

test('reports each session separately, and skips the ones that are whole', () => {
  const gaps = detectSessionRepoGaps(
    [
      sess({ id: 'short' }),
      sess({
        id: 'whole',
        feature: 'unrelated',
        repos: [{ repoPath: '/r/other' }],
      }),
    ],
    scan(),
    byName,
  );
  assert.deepEqual(
    gaps.map((g) => g.sessionId),
    ['short'],
  );
});

test('asks the identity resolver, so it reconciles under every strategy', () => {
  const byBranch = (i: { branch?: string | null }) => (i.branch || '').replace(/^fix\//, '');
  const gaps = detectSessionRepoGaps([sess()], scan(), byBranch);
  assert.deepEqual(
    gaps[0].missing.map((m) => m.repo),
    ['merchant-v3', 'ab-libraries'],
  );
});

test('takes one worktree per repo, not several', () => {
  const repos = [
    {
      name: 'accept-blue',
      path: '/r/accept-blue',
      worktrees: [wt('feat-x', '/r/a/1'), wt('feat-x', '/r/a/2')],
    },
  ];
  assert.equal(attachableWorktrees(repos, 'feat-x', new Set(), byName).length, 1);
});
