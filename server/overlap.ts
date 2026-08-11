/*
 * WHAT ELSE IS TOUCHING THIS FILE, and how far the branch has drifted.
 *
 * Studio is the only thing that knows about every worktree at once, and this is the
 * question that fact answers. Two agents editing `helpers/mfa.js` in two worktrees is
 * invisible to git — each has a clean status, each builds, each passes — right up until
 * one of them merges and the other's rebase turns into an afternoon. Measured on the
 * owner's live checkout the day this was written:
 *
 *     iso-mfa-totp   x merchant-mfa              18 shared files
 *     custom-reports x recurring-invoice-review   3 shared files
 *
 * Both halves come from the same three git reads, which is why they are one module:
 *
 *   collision — the files a feature changed since its merge-base, intersected with
 *               every other feature's set, per repo. Features only collide inside one
 *               repo, so the pairing never crosses repos.
 *   drift     — how far behind the base a branch is, and the useful half of that: which
 *               of the files YOU changed have ALSO changed on the base since you branched.
 *               That set is what will actually conflict, and it is knowable now rather
 *               than during the rebase.
 *
 * CACHED ON THE PAIR OF SHAS, not on a clock. The answer changes only when this branch
 * commits or the base moves, so a sweep that finds both unchanged costs one `rev-parse`
 * per worktree and no diffs at all. That is what makes it affordable to run on the same
 * cadence as the CI feed.
 */
import { git } from './util.ts';
import type { Drift, FeatureOverlap } from './types.ts';

/** One worktree's answer, cached against the shas it was computed from. */
interface Entry {
  headSha: string;
  baseSha: string;
  /** Files changed since the merge-base — what a collision is computed from. */
  changed: string[];
  behind: number;
  ahead: number;
  /** Of `changed`, the ones the base also touched since the merge-base. */
  conflicts: string[];
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
 * a row of zeroes that reads as "no drift, no collisions".
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

  const [mine, theirs, behind, ahead] = await Promise.all([
    git(wt, ['diff', '--name-only', `${mb}..${headSha}`]),
    git(wt, ['diff', '--name-only', `${mb}..${baseSha}`]),
    git(wt, ['rev-list', '--count', `${headSha}..${baseSha}`]),
    git(wt, ['rev-list', '--count', `${baseSha}..${headSha}`]),
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
      /** repo → feature → the files it changed there. */
      const byRepo = new Map<string, Map<string, string[]>>();
      const drift = new Map<string, Drift[]>();

      for (const f of features) {
        for (const m of f.members || []) {
          if (!m?.path || !m.repo) continue;
          const e = await read(cache, m.path, baseFor(m.repo));
          if (!e) continue;
          if (!byRepo.has(m.repo)) byRepo.set(m.repo, new Map());
          byRepo.get(m.repo)!.set(f.name, e.changed);
          const list = drift.get(f.name) || [];
          list.push({ repo: m.repo, behind: e.behind, ahead: e.ahead, conflicts: e.conflicts });
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
          drift: d.filter((x) => x.behind || x.ahead || x.conflicts.length),
          collisions: [],
        };
      }

      // Pairwise, per repo. Each pair is compared once and recorded on BOTH features:
      // the warning is symmetric, and whichever one you happen to be looking at is the
      // one that has to tell you.
      for (const [repo, perFeature] of byRepo) {
        const names = [...perFeature.keys()];
        for (let i = 0; i < names.length; i++) {
          for (let j = i + 1; j < names.length; j++) {
            const a = names[i];
            const b = names[j];
            const setB = new Set(perFeature.get(b) || []);
            const shared = (perFeature.get(a) || []).filter((file) => setB.has(file));
            if (!shared.length) continue;
            shared.sort();
            next[a]?.collisions.push({ feature: b, repo, files: shared });
            next[b]?.collisions.push({ feature: a, repo, files: shared });
          }
        }
      }

      // Most shared files first: the pair most likely to hurt is the one worth naming.
      for (const v of Object.values(next)) {
        v.collisions.sort((x, y) => y.files.length - x.files.length);
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
