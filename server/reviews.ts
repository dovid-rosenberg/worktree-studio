/*
 * Merge requests waiting on YOU.
 *
 * Studio has only ever known about work you started. Four MRs sat in one repo for five
 * days when this was written, all of them invisible here, because a review is not a
 * feature: no worktree, no agent, no dev server, nothing on disk at all until you decide
 * to look at it.
 *
 * PULLED AND CACHED HARD, like task-status.ts and for the same reasons: it is external
 * state on somebody else's server, a `gh`/`glab` process per repo is not free, and a
 * reviewer being added is a human action measured in minutes. So a long TTL, one sweep at
 * a time, and — the part that is easy to leave out — a FAILURE IS REMEMBERED as a failure,
 * so a forge that is down or a token that has expired does not mean a dozen doomed
 * subprocesses every sweep for the rest of the day.
 *
 * "@me" is resolved by the CLI from whichever credential it is using. Studio never learns
 * or stores who you are on a forge, and swapping a token changes the answer without
 * changing a line of config here.
 */
import type { ReviewItem } from './types.ts';

/** A reviewer being added is a human action; minutes-stale is fine. */
const TTL_MS = 5 * 60 * 1000;
/** Long enough that an outage costs a handful of processes an hour, not hundreds. */
const ERROR_TTL_MS = 15 * 60 * 1000;

interface Entry {
  at: number;
  items: ReviewItem[];
  error?: string;
}

/** One repo to ask about — its name, and the checkout to ask from. */
export interface ReviewRepo {
  name: string;
  path: string;
}

export interface ReviewFeed {
  /** The current answer, flattened across repos — synchronous, for folding into a frame. */
  snapshot(): ReviewItem[];
  /** Refresh anything stale. Safe to call often; does nothing when nothing is due. */
  refresh(repos: ReviewRepo[]): Promise<boolean>;
  /** Drop a repo's cache — used when a lookup should be retried now rather than at TTL. */
  forget(repo: string): void;
}

export interface ReviewDeps {
  /**
   * Ask one checkout. Returns null when no provider could answer at all — which is
   * different from "answered, nothing waiting", and only the first is worth retrying
   * slowly.
   */
  list(repoPath: string): Promise<ReviewItem[] | null>;
  now?: () => number;
}

export function createReviewFeed({ list, now = () => Date.now() }: ReviewDeps): ReviewFeed {
  const cache = new Map<string, Entry>();
  let sig = '[]';
  let running = false;

  const fresh = (e: Entry | undefined): boolean =>
    !!e && now() - e.at < (e.error ? ERROR_TTL_MS : TTL_MS);

  function snapshot(): ReviewItem[] {
    const out: ReviewItem[] = [];
    for (const e of cache.values()) out.push(...e.items);
    /*
     * Newest first, drafts last.
     *
     * A draft is somebody thinking out loud — it is in the queue because they asked, but
     * reviewing it is rarely the next thing to do. Sorting rather than hiding: a draft
     * that has been sitting for a week is still worth seeing.
     */
    return out.sort(
      (a, b) =>
        Number(a.draft) - Number(b.draft) ||
        String(b.updatedAt).localeCompare(String(a.updatedAt)),
    );
  }

  async function refresh(repos: ReviewRepo[]): Promise<boolean> {
    if (running) return false;
    running = true;
    try {
      const live = new Set(repos.map((r) => r.name));
      for (const k of [...cache.keys()]) if (!live.has(k)) cache.delete(k);

      for (const r of repos) {
        if (fresh(cache.get(r.name))) continue;
        try {
          const items = await list(r.path);
          cache.set(
            r.name,
            items === null
              ? { at: now(), items: [], error: 'no forge CLI could answer' }
              : // The CLI answers per checkout and cannot know the repo's name here, so
                // the sweep is what stamps it — see ReviewItem.repo.
                { at: now(), items: items.map((i) => ({ ...i, repo: r.name })) },
          );
        } catch (e) {
          cache.set(r.name, { at: now(), items: [], error: (e as Error).message });
        }
      }

      const next = JSON.stringify(snapshot());
      if (next === sig) return false;
      sig = next;
      return true;
    } finally {
      running = false;
    }
  }

  return {
    snapshot,
    refresh,
    forget(repo: string) {
      cache.delete(repo);
    },
  };
}
