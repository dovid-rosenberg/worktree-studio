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
 * is the daemon making hundreds of doomed requests an hour.
 */
import * as sources from './sources/index.ts';
import type { Config, PartialDeep, TaskStatus } from './types.ts';

/** How long a resolved status is trusted. A human moving a card is not a fast event. */
const TTL_MS = 10 * 60 * 1000;

/** How long to wait before retrying a lookup that failed, so an outage is not hammered. */
const ERROR_TTL_MS = 5 * 60 * 1000;

interface Entry {
  at: number;
  status: TaskStatus | null;
  /** Set when the last attempt threw — kept so the message can be shown once, not looped. */
  error?: string;
}

export interface TaskStatusMap {
  /** featureName → its ticket's status, absent when there is none or it is unknown. */
  [feature: string]: TaskStatus;
}

export interface TaskStatusFeed {
  /** The current snapshot — synchronous, so it can be folded into a frame. */
  snapshot(): TaskStatusMap;
  /** Refresh anything stale. Safe to call often; it does nothing when nothing is due. */
  refresh(features: Array<{ name: string; ticket?: string }>): Promise<boolean>;
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
  const cache = new Map<string, Entry>();
  let running = false;

  function snapshot(): TaskStatusMap {
    const out: TaskStatusMap = {};
    for (const [name, e] of cache) if (e.status) out[name] = e.status;
    return out;
  }

  function fresh(e: Entry | undefined): boolean {
    if (!e) return false;
    return now() - e.at < (e.error ? ERROR_TTL_MS : TTL_MS);
  }

  async function refresh(features: Array<{ name: string; ticket?: string }>): Promise<boolean> {
    // One sweep at a time. Two overlapping sweeps would double every request for no
    // benefit, since the second would find the first's entries still unwritten.
    if (running) return false;
    const due = features.filter((f) => f.ticket && !fresh(cache.get(f.name)));
    if (!due.length) return false;

    running = true;
    let changed = false;
    try {
      for (const f of due) {
        try {
          const status = await resolve(deps.cfg, f.ticket as string);
          const prev = cache.get(f.name)?.status;
          if (prev?.label !== status?.label || prev?.done !== status?.done) changed = true;
          cache.set(f.name, { at: now(), status });
        } catch (e) {
          // Recorded, not thrown: one unreachable tracker must not stop the others, and
          // the timestamp is what stops this retrying on every sweep.
          cache.set(f.name, {
            at: now(),
            status: cache.get(f.name)?.status ?? null,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } finally {
      running = false;
    }
    return changed;
  }

  return {
    snapshot,
    refresh,
    forget(name: string) {
      cache.delete(name);
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
