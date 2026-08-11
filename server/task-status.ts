/*
 * Where each feature's ticket sits in its tracker — "Backlog", "In Progress", "Done".
 *
 * The one part of a link that CANNOT be derived from its URL. server/links.ts resolves a
 * label and a glyph by pattern precisely so that display needs no auth and no API; a
 * status is a fact living on the tracker's server, so it needs both. That is the whole
 * reason this is a separate module rather than another field in `assemble()`.
 *
 * PULLED, not pushed, and cached hard. A status changes when a human drags a card between
 * columns — minutes to days — while the topology frame is rebuilt on every repo scan.
 * Folding a network call into that would put a per-feature HTTP round trip on a path that
 * fires whenever a file changes. So: a long TTL, one refresh at a time, and nothing
 * fetched at all for a feature with no ticket.
 *
 * A failure is REMEMBERED as a failure. Without that, a tracker that is down or a token
 * that has expired means every sweep retries every ticket forever, and the only symptom
 * is the daemon making hundreds of doomed requests an hour. That rule, the TTL and the
 * one-sweep-at-a-time guard are polled-cache.ts's now; the tracker call is what is left.
 */
import { createPolledCache } from './polled-cache.ts';
import * as sources from './sources/index.ts';
import type { Config, PartialDeep, TaskStatus } from './types.ts';

/** How long a resolved status is trusted. A human moving a card is not a fast event. */
const TTL_MS = 10 * 60 * 1000;

/** How long to wait before retrying a lookup that failed, so an outage is not hammered. */
const ERROR_TTL_MS = 5 * 60 * 1000;

/** One feature to ask about — its name, and the ticket URL to resolve (absent: nothing to ask). */
interface Ticketed {
  name: string;
  ticket?: string;
}

export interface TaskStatusMap {
  /** featureName → its ticket's status, absent when there is none or it is unknown. */
  [feature: string]: TaskStatus;
}

export interface TaskStatusFeed {
  /** The current snapshot — synchronous, so it can be folded into a frame. */
  snapshot(): TaskStatusMap;
  /**
   * Refresh anything stale. Safe to call often; it does nothing when nothing is due, and
   * NEVER REJECTS — the callers `void` it, and crash.ts makes an unhandled rejection
   * fatal, so a tracker throwing would otherwise exit the daemon. Returns whether the
   * snapshot moved, i.e. whether a frame is worth sending.
   */
  refresh(features: Ticketed[]): Promise<boolean>;
  /** Forget a feature — called when one is deleted, so the map cannot grow forever. */
  forget(name: string): void;
}

export function createTaskStatusFeed(deps: {
  cfg: PartialDeep<Config>;
  /** Injected so a test can drive the contract without a token or a network. */
  resolve?: (cfg: PartialDeep<Config>, url: string) => Promise<TaskStatus | null>;
  now?: () => number;
}): TaskStatusFeed {
  const now = deps.now || (() => Date.now());
  const resolve = deps.resolve || defaultResolve;
  const cache = createPolledCache<string, TaskStatus | null, Ticketed>({
    ttlMs: TTL_MS,
    errorTtlMs: ERROR_TTL_MS,
    now,
    key: (f) => f.name,
    load: (f) => resolve(deps.cfg, f.ticket as string),
    // Keep the last known column rather than blanking it: an unreachable tracker means we
    // no longer know, not that the card moved back to nothing — and a status that flickers
    // out and back in is a frame to every client each way.
    onError: (_f, _e, previous) => previous?.value ?? null,
    blank: {},
  });

  function snapshot(): TaskStatusMap {
    const out: TaskStatusMap = {};
    for (const [name, e] of cache.entries()) if (e.value) out[name] = e.value;
    return out;
  }

  async function refresh(features: Ticketed[]): Promise<boolean> {
    // A feature with no ticket is not asked about at all — there is nothing to ask. Not
    // pruned either: the cache is keyed by feature and cleared by forget(), because this
    // list is only the ticketed subset and pruning against it would forget every feature
    // whose ticket was momentarily unreadable from config.
    const { ran } = await cache.refresh(features.filter((f) => f.ticket));
    return ran && cache.changed(snapshot());
  }

  return {
    snapshot,
    refresh,
    forget(name: string) {
      cache.forget(name);
    },
  };
}

/**
 * Ask whichever enabled adapter recognises this URL.
 *
 * Matched on the adapter's own id appearing in the host, which is the same substring
 * approach links.ts uses and covers a self-hosted instance the way an equality test could
 * not. An adapter with no `status` method is skipped rather than guessed at — the absence
 * means "this tracker cannot tell us", which is not the same as "no status".
 */
async function defaultResolve(cfg: PartialDeep<Config>, url: string): Promise<TaskStatus | null> {
  for (const a of sources.enabledAdapters(cfg)) {
    if (!a.status) continue;
    if (!url.includes(a.id)) continue;
    return a.status(cfg, url);
  }
  return null;
}
