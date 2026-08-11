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
import { currentBranch } from './git.ts';
import type { Drift, FeatureOverlap } from './types.ts';

/** One worktree's answer, cached against the shas it was computed from. */
interface Entry {
  headSha: string;
  baseSha: string;
  /** Files changed since the merge-base — what `conflicts` is filtered from. */
  changed: string[];
  behind: number;
  ahead: number;
  /** Of `changed`, the ones the base also touched since the merge-base. */
  conflicts: string[];
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
  /** Recompute. Cheap when nothing has moved; safe to call often. */
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
async function measure(
  cache: Map<string, Entry>,
  wt: string,
  base: string,
): Promise<Entry | null> {
  const headSha = await git(wt, ['rev-parse', 'HEAD']);
  if (!headSha) return null;
  // The base is read in the WORKTREE, so it resolves through that worktree's own remotes
  // — and `origin/master` is a moving target, which is exactly why it is part of the key.
  const baseSha = await git(wt, ['rev-parse', base]);
  if (!baseSha) return null;

  const hit = cache.get(wt);
  if (hit && hit.headSha === headSha && hit.baseSha === baseSha) return hit;

  const mb = await git(wt, ['merge-base', headSha, baseSha]);
  if (!mb) return null;

  // The branch's own name, so `origin/<branch>` can be asked about. Detached (null) has
  // no remote counterpart at all.
  const branch = await currentBranch(wt);

  const [mine, theirs, behind, ahead, unpushedRaw] = await Promise.all([
    git(wt, ['diff', '--name-only', `${mb}..${headSha}`]),
    git(wt, ['diff', '--name-only', `${mb}..${baseSha}`]),
    git(wt, ['rev-list', '--count', `${headSha}..${baseSha}`]),
    git(wt, ['rev-list', '--count', `${baseSha}..${headSha}`]),
    // `--` guards a branch name that could be read as a path. An unknown revision exits
    // non-zero and `git()` answers '', which is what "never pushed" looks like here.
    branch ? git(wt, ['rev-list', '--count', `origin/${branch}..HEAD`, '--']) : Promise.resolve(''),
  ]);

  const changed = mine.split('\n').filter(Boolean);
  const onBase = new Set(theirs.split('\n').filter(Boolean));
  const entry: Entry = {
    headSha,
    baseSha,
    changed,
    behind: Number(behind) || 0,
    ahead: Number(ahead) || 0,
    conflicts: changed.filter((f) => onBase.has(f)),
    unpushed: unpushedRaw === '' ? null : Number(unpushedRaw) || 0,
  };
  cache.set(wt, entry);
  return entry;
}

export function createOverlapFeed(deps: {
  /** Injected so tests drive the contract without spawning git. */
  read?: typeof measure;
} = {}): OverlapFeed {
  const read = deps.read || measure;
  const cache = new Map<string, Entry>();
  let snap: OverlapSnapshot = {};
  let sig = '{}';
  let running = false;

  async function refresh(
    features: OverlapFeature[],
    baseFor: (repo: string) => string,
  ): Promise<boolean> {
    // One sweep at a time. These are git reads over every worktree, and two overlapping
    // sweeps would double that for an answer neither of them would produce sooner.
    if (running) return false;
    running = true;
    try {
      const drift = new Map<string, Drift[]>();

      for (const f of features) {
        for (const m of f.members || []) {
          if (!m?.path || !m.repo) continue;
          const e = await read(cache, m.path, baseFor(m.repo));
          if (!e) continue;
          const list = drift.get(f.name) || [];
          list.push({
            repo: m.repo,
            behind: e.behind,
            ahead: e.ahead,
            conflicts: e.conflicts,
            unpushed: e.unpushed,
          });
          drift.set(f.name, list);
        }
      }

      const next: OverlapSnapshot = {};
      for (const f of features) {
        const d = drift.get(f.name) || [];
        if (!d.length) continue;
        next[f.name] = {
          // The WORST case across repos, because one stale half of a feature is a stale
          // feature — summing or averaging would hide exactly the repo that needs work.
          behind: Math.max(0, ...d.map((x) => x.behind)),
          ahead: d.reduce((n, x) => n + x.ahead, 0),
          drift: d.filter((x) => x.behind || x.ahead || x.conflicts.length || x.unpushed),
        };
      }

      // Drop worktrees that have gone, so the cache tracks reality rather than history.
      const live = new Set(features.flatMap((f) => (f.members || []).map((m) => m?.path)));
      for (const k of [...cache.keys()]) if (!live.has(k)) cache.delete(k);

      const nextSig = JSON.stringify(next);
      if (nextSig === sig) return false;
      sig = nextSig;
      snap = next;
      return true;
    } finally {
      running = false;
    }
  }

  return {
    snapshot: () => snap,
    refresh,
    forget(name: string) {
      if (name in snap) {
        delete snap[name];
        sig = JSON.stringify(snap);
      }
    },
  };
}
