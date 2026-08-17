/*
 * HOW FAR A BRANCH HAS DRIFTED FROM ITS BASE.
 *
 * Two numbers and a list: how far behind, how far ahead, and the useful part — which of
 * the files YOU changed have ALSO changed on the base since you branched. That last set
 * is what a rebase will actually fight, and it is knowable now rather than halfway
 * through one.
 *
 * This module also computed cross-feature COLLISIONS — which other feature is changing
 * the same files. The data was right (18 shared files between two live features when it
 * shipped) and the owner did not want the warning, so it is gone rather than left behind
 * a flag: the pairwise intersection was the only reason `changed` was kept per feature.
 * The per-worktree read stays because `conflicts` needs it.
 *
 * CACHED ON THE PAIR OF SHAS, not on a clock. The answer changes only when this branch
 * commits or the base moves, so a sweep that finds both unchanged costs one `rev-parse`
 * per worktree and no diffs at all. That is what makes it affordable to run on the same
 * cadence as the CI feed.
 */
import { git } from './util.ts';
import { currentBranch, readDrift } from './git.ts';
import type { DriftRead } from './git.ts';
import { createPolledCache } from './polled-cache.ts';
import type { Drift, FeatureOverlap } from './types.ts';

/**
 * No clock freshness at all: the answer is keyed on the pair of shas, so every sweep asks
 * and `measure` short-circuits on two `rev-parse`s when neither end has moved. A TTL here
 * would only delay noticing a commit that already happened.
 */
const TTL_MS = 0;

/**
 * …but a git read that THROWS is remembered, which is the rule this feed did not have and
 * the other pulled feeds did. A worktree whose git is mid-rewrite, or a path that makes
 * the spawn itself fail, used to cost a process on every single sweep forever.
 */
const ERROR_TTL_MS = 60 * 1000;

/**
 * One worktree's answer, cached against the shas it was computed from.
 *
 * The drift half is git.DriftRead — the same read POST /group/update refuses on, rather
 * than a parallel copy of it. What this feed adds is the one number a rebase does not
 * care about and shipping does.
 */
interface Entry extends DriftRead {
  /**
   * Commits on this branch that `origin/<branch>` does not have — work that exists only
   * on this laptop. Null when the branch has never been pushed, which is a different
   * sentence ("no branch on the remote") from "3 commits ahead of it".
   */
  unpushed: number | null;
}

/** A feature's member worktree, narrowed to what a git read needs. */
export interface OverlapMember {
  repo: string;
  path: string;
  branch?: string | null;
}

export interface OverlapFeature {
  name: string;
  members: OverlapMember[];
}

export type OverlapSnapshot = Record<string, FeatureOverlap>;

export interface OverlapFeed {
  /** The current answer — synchronous, so it can be folded into a frame. */
  snapshot(): OverlapSnapshot;
  /**
   * Recompute. Cheap when nothing has moved; safe to call often, and NEVER REJECTS — the
   * callers `void` it from the rescan path, and crash.ts makes an unhandled rejection
   * fatal, so one unreadable worktree would otherwise exit the daemon with every PTY in it.
   */
  refresh(features: OverlapFeature[], baseFor: (repo: string) => string): Promise<boolean>;
  /** Drop a feature that no longer exists, so the map cannot grow forever. */
  forget(name: string): void;
}

/**
 * Read one worktree, reusing the cached answer when neither end has moved.
 *
 * Returns null when the worktree cannot be read at all — a removed directory, a repo with
 * no such base — because a feature we cannot measure must contribute nothing rather than
 * a row of zeroes that reads as "up to date".
 */
async function measure(previous: Entry | null, wt: string, base: string): Promise<Entry | null> {
  const headSha = await git(wt, ['rev-parse', 'HEAD']);
  if (!headSha) return null;
  // The base is read in the WORKTREE, so it resolves through that worktree's own remotes
  // — and `origin/master` is a moving target, which is exactly why it is part of the key.
  const baseSha = await git(wt, ['rev-parse', base]);
  if (!baseSha) return null;

  if (previous && previous.headSha === headSha && previous.baseSha === baseSha) return previous;

  // The branch's own name, so `origin/<branch>` can be asked about. Detached (null) has
  // no remote counterpart at all.
  const branch = await currentBranch(wt);

  // The merge-base arithmetic itself lives in git.readDrift, because POST /group/update
  // reads it too: the verb refuses a rebase this feed has already predicted will conflict,
  // and a second implementation of that prediction would eventually disagree with the
  // number on the chip the user pressed. The shas are handed over so the split costs no
  // extra spawns.
  const [drift, unpushedRaw] = await Promise.all([
    readDrift(wt, base, { headSha, baseSha }),
    // `--` guards a branch name that could be read as a path. An unknown revision exits
    // non-zero and `git()` answers '', which is what "never pushed" looks like here.
    branch ? git(wt, ['rev-list', '--count', `origin/${branch}..HEAD`, '--']) : Promise.resolve(''),
  ]);
  if (!drift) return null;

  return { ...drift, unpushed: unpushedRaw === '' ? null : Number(unpushedRaw) || 0 };
}

export function createOverlapFeed(
  deps: {
    /** Injected so tests drive the contract without spawning git. */
    read?: typeof measure;
    /** Injected so a test can cross the error TTL without waiting a minute out. */
    now?: () => number;
  } = {},
): OverlapFeed {
  const read = deps.read || measure;
  let snap: OverlapSnapshot = {};
  // The base to measure against is a property of the SWEEP, not of the cache: it is
  // derived from the topology each time and can change under us (a repo's default branch
  // moves). Held here so `load` — which the cache calls per member — can see the one the
  // running sweep was given.
  let baseOf: (repo: string) => string = () => 'master';

  const cache = createPolledCache<string, Entry | null, OverlapMember>({
    ttlMs: TTL_MS,
    errorTtlMs: ERROR_TTL_MS,
    now: deps.now,
    key: (m) => m.path,
    load: (m, previous) => read(previous?.value ?? null, m.path, baseOf(m.repo)),
    onError: () => null,
    blank: {},
  });

  async function refresh(features: OverlapFeature[], baseFor: (repo: string) => string): Promise<boolean> {
    baseOf = baseFor;
    const members = features.flatMap((f) =>
      (f.members || []).filter((m): m is OverlapMember => !!m?.path && !!m.repo),
    );
    // prune: a worktree that has gone must leave the cache with it, so the snapshot
    // tracks reality rather than history.
    const { ran } = await cache.refresh(members, { prune: true });
    if (!ran) return false;

    const next: OverlapSnapshot = {};
    for (const f of features) {
      const d: Drift[] = [];
      for (const m of f.members || []) {
        if (!m?.path || !m.repo) continue;
        // Null is "we could not measure this one" — a feature we cannot measure must
        // contribute nothing rather than a row of zeroes that reads as "up to date".
        const e = cache.get(m.path)?.value;
        if (!e) continue;
        d.push({
          repo: m.repo,
          behind: e.behind,
          ahead: e.ahead,
          conflicts: e.conflicts,
          unpushed: e.unpushed,
        });
      }
      if (!d.length) continue;
      next[f.name] = {
        // The WORST case across repos, because one stale half of a feature is a stale
        // feature — summing or averaging would hide exactly the repo that needs work.
        behind: Math.max(0, ...d.map((x) => x.behind)),
        ahead: d.reduce((n, x) => n + x.ahead, 0),
        drift: d.filter((x) => x.behind || x.ahead || x.conflicts.length || x.unpushed),
      };
    }

    if (!cache.changed(next)) return false;
    snap = next;
    return true;
  }

  return {
    snapshot: () => snap,
    refresh,
    forget(name: string) {
      if (name in snap) {
        delete snap[name];
        // Re-signed against what the snapshot now IS, so the next sweep that rebuilds the
        // forgotten feature is seen as a change rather than as the same old answer.
        cache.changed(snap);
      }
    },
  };
}
