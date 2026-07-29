import { test } from 'node:test';
import assert from 'node:assert';
import { createIdentity } from '../server/identity.ts';
import type { Config, PartialDeep } from '../server/types.ts';

/*
 * Feature identity, asserted as PROPERTIES rather than examples.
 *
 * Identity is the hinge the whole app turns on: two worktrees are "the same feature"
 * iff they resolve to the same string, and that one answer drives the rail's grouping,
 * the concurrency slot a stack gets, which ports are offset, and what `Run stack`
 * starts. A quiet change here does not throw — it silently regroups the user's work.
 *
 * Example-based tests pin the cases someone thought of. These pin the rules that must
 * hold for ALL inputs, generated from a seeded corpus so a failure is reproducible.
 *
 * They assert `of()`, which IS the identity. `nameOf()` is the layout's name for a
 * worktree and never consults the branch — asserting on it makes every branch-strategy
 * case vacuously true, which is exactly what the first draft of this file did.
 */

const cfg = (over: PartialDeep<Config> = {}): Config => ({
  baseDirs: [],
  worktrees: { layout: 'nested', dir: '.worktrees' },
  featureIdentity: { strategy: 'basename' },
  ...over,
} as unknown as Config);

/*
 * A tiny deterministic PRNG. `Math.random()` would make a failure unreproducible, and
 * a failure you cannot re-run is a rumour.
 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const REPOS = ['accept-blue', 'merchant-v3', 'ab-iso-fe', 'ab-su'];
const NAMES = ['merchant-mfa', 'token-race-fix', 'custom-reports', 'a', 'x-y-z', 'UPPER', 'with.dots'];
const PREFIX = ['feature', 'fix', 'chore', ''];

function corpus(seed: number, n: number) {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  return Array.from({ length: n }, () => {
    const repo = pick(REPOS);
    const wtname = pick(NAMES);
    const p = pick(PREFIX);
    return {
      repo,
      wtname,
      branch: p ? `${p}/${wtname}` : wtname,
      path: `/base/${repo}/.worktrees/${wtname}`,
    };
  });
}

/*
 * The branch strategy needs a pattern: without one it WARNS and falls back to basename,
 * so a `branch` config with no branchPattern is not the branch strategy at all. Writing
 * these without it meant four tests labelled [branch] were quietly exercising basename.
 */
const BRANCH_PATTERN = '^(?:feature|fix|chore)/(.+)$';

type IdCfg = NonNullable<PartialDeep<Config>['featureIdentity']>;

const STRATEGIES: { strategy: string; featureIdentity: IdCfg }[] = [
  { strategy: 'basename', featureIdentity: { strategy: 'basename' } },
  { strategy: 'branch', featureIdentity: { strategy: 'branch', branchPattern: BRANCH_PATTERN } },
];

for (const { strategy, featureIdentity } of STRATEGIES) {
  const id = createIdentity(cfg({ featureIdentity }));

  test(`[${strategy}] identity is deterministic — same input, same answer`, () => {
    for (const w of corpus(1, 200)) {
      assert.equal(id.of(w), id.of({ ...w }), `unstable for ${JSON.stringify(w)}`);
    }
  });

  test(`[${strategy}] identity never answers empty`, () => {
    // An empty identity would collapse unrelated worktrees into one feature and hand
    // them a shared concurrency slot.
    for (const w of corpus(2, 200)) {
      const got = id.of(w);
      assert.equal(typeof got, 'string');
      assert.ok(got.length > 0, `empty identity for ${JSON.stringify(w)}`);
    }
  });

  test(`[${strategy}] identity ignores the repo it came from`, () => {
    // This is the property that makes a BE+FE feature a feature at all: the same
    // worktree name in two repos must group, or "Run stack" starts half of it.
    for (const w of corpus(3, 150)) {
      const others = REPOS.filter((r) => r !== w.repo);
      for (const other of others) {
        const moved = { ...w, repo: other, path: `/base/${other}/.worktrees/${w.wtname}` };
        assert.equal(id.of(moved), id.of(w), `repo leaked into identity for ${JSON.stringify(w)}`);
      }
    }
  });

  test(`[${strategy}] identity is stable under a different base directory`, () => {
    // Worktrees live under whatever baseDirs the user configured; where the checkout
    // sits on disk is not part of what the work IS.
    for (const w of corpus(4, 150)) {
      const moved = { ...w, path: `/somewhere/else/${w.repo}/.worktrees/${w.wtname}` };
      assert.equal(id.of(moved), id.of(w));
    }
  });
}

test('[basename] two worktrees group iff they share a name', () => {
  const id = createIdentity(cfg({ featureIdentity: { strategy: 'basename' } }));
  for (const a of corpus(5, 60)) {
    for (const b of corpus(6, 12)) {
      const same = id.of(a) === id.of(b);
      assert.equal(same, a.wtname === b.wtname, `${a.wtname} vs ${b.wtname} grouped ${same}`);
    }
  }
});

test('[branch] identity follows the branch, so differing branches do NOT group', () => {
  // The strategy exists for teams whose worktree names differ per repo; the trade is
  // that a feature whose branches differ stops being one feature.
  const id = createIdentity(cfg({ featureIdentity: { strategy: 'branch', branchPattern: BRANCH_PATTERN } }));
  const a = { repo: 'accept-blue', wtname: 'merchant-mfa', branch: 'feature/merchant-mfa-totp', path: '/b/a/.worktrees/merchant-mfa' };
  const b = { repo: 'merchant-v3', wtname: 'merchant-mfa', branch: 'feature/mfa-totp', path: '/b/m/.worktrees/merchant-mfa' };
  assert.notEqual(id.of(a), id.of(b));

  // …and the same branch in two repos does.
  const c = { ...b, branch: a.branch };
  assert.equal(id.of(a), id.of(c));
});

test('identity survives the inputs that are missing fields', () => {
  // These arrive from a scan of the filesystem, so a detached head, a bare wtname or
  // a null branch are all reachable states, not hypotheticals.
  const id = createIdentity(cfg());
  for (const bad of [
    {},
    { repo: 'accept-blue' },
    { wtname: 'x' },
    { repo: 'accept-blue', wtname: 'x', branch: null },
    { repo: 'accept-blue', wtname: '', branch: '' },
  ]) {
    assert.doesNotThrow(() => id.of(bad as never), `threw on ${JSON.stringify(bad)}`);
    assert.equal(typeof id.of(bad as never), 'string');
  }
  assert.equal(typeof id.of(null), 'string');
  assert.equal(typeof id.ofPath(null), 'string');
});
