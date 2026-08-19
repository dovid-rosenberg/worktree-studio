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
 * subprocesses every sweep for the rest of the day. All four of those rules now live in
 * polled-cache.ts; what stays here is the `gh`/`glab` call and the shape of the answer.
 *
 * "@me" is resolved by the CLI from whichever credential it is using. Studio never learns
 * or stores who you are on a forge, and swapping a token changes the answer without
 * changing a line of config here.
 */
import { createPolledCache } from './polled-cache.ts';
import type { ReviewItem } from './types.ts';

/** A reviewer being added is a human action; minutes-stale is fine. */
const TTL_MS = 5 * 60 * 1000;
/** Long enough that an outage costs a handful of processes an hour, not hundreds. */
const ERROR_TTL_MS = 15 * 60 * 1000;

/** One repo to ask about — its name, and the checkout to ask from. */
export interface ReviewRepo {
  name: string;
  path: string;
}

export interface ReviewFeed {
  /** The current answer, flattened across repos — synchronous, for folding into a frame. */
  snapshot(): ReviewItem[];
  /**
   * Refresh anything stale. Safe to call often; does nothing when nothing is due, and
   * NEVER REJECTS — the callers `void` it, and crash.ts makes an unhandled rejection
   * fatal. Returns whether the answer moved, i.e. whether a frame is worth sending.
   */
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
  const cache = createPolledCache<string, ReviewItem[], ReviewRepo>({
    ttlMs: TTL_MS,
    errorTtlMs: ERROR_TTL_MS,
    now,
    key: (r) => r.name,
    load: async (r) => {
      const items = await list(r.path);
      // `null` and `[]` are different facts. Null means no provider could answer at all,
      // and only that is worth retrying slowly — collapsing them would either retry a
      // quiet repo forever or never retry a broken one. Thrown, so it lands on the error
      // TTL like any other failure.
      if (items === null) throw new Error('no forge CLI could answer');
      // The CLI answers per checkout and cannot know the repo's name here, so the sweep
      // is what stamps it — see ReviewItem.repo.
      return items.map((i) => ({ ...i, repo: r.name }));
    },
    onError: () => [],
    blank: [],
  });

  function snapshot(): ReviewItem[] {
    const out: ReviewItem[] = [];
    for (const [, e] of cache.entries()) out.push(...e.value);
    /*
     * Newest first, drafts last.
     *
     * A draft is somebody thinking out loud — it is in the queue because they asked, but
     * reviewing it is rarely the next thing to do. Sorting rather than hiding: a draft
     * that has been sitting for a week is still worth seeing.
     */
    return out.sort(
      (a, b) => Number(a.draft) - Number(b.draft) || String(b.updatedAt).localeCompare(String(a.updatedAt)),
    );
  }

  async function refresh(repos: ReviewRepo[]): Promise<boolean> {
    // prune: a repo that has left the scan must not leave rows on the rail behind it.
    const { ran } = await cache.refresh(repos, { prune: true });
    return ran && cache.changed(snapshot());
  }

  return {
    snapshot,
    refresh,
    forget(repo: string) {
      cache.forget(repo);
    },
  };
}
