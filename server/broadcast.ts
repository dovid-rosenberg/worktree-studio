// The SSE fan-out. One stream, three named event types, because the state payload
// (server/state.js, docs/api.md) has three very different change rates:
//
//   topology       repos → worktrees → features/groups, plus the config a client
//                  renders its chrome from. Changes when git is rescanned (15 s),
//                  when a worktree or session is created/removed, or when
//                  dev-server discovery finds something new.
//   session-state  { sessions, servers } — the half a Claude Code hook touches.
//                  Every tool call in every session lands here, so it has to stay
//                  small: it is the only thing most broadcasts send.
//   ci             { ci } — each session's PR/MR + checks (server/ci.js). Its own
//                  event precisely BECAUSE session-state is the hook half: CI moves
//                  on the order of minutes, so riding along with every tool call
//                  would re-send an unchanged payload thousands of times. It is
//                  emitted only when the snapshot actually differs, and it is the
//                  one half nothing on the hot path has to build.
//
// All three events are FULL REPLACEMENTS of their half, never per-item deltas. The
// session half is small enough that re-sending it costs less than the
// add/update/remove vocabulary a delta needs, a replacement is idempotent and
// order-independent (so a duplicate or an out-of-order frame can't corrupt a
// client), and it communicates removals for free — a closed session is simply
// absent. A client applies a frame with `state = { ...state, ...frame }`.
//
// A new subscriber is sent one of each *synchronously, before it joins the
// broadcast set*, so it always starts from a complete snapshot and can never see
// a delta that predates it. Browsers reconnect an EventSource on their own, and a
// reconnect is just a new subscriber: it re-snapshots and converges rather than
// drifting from whatever it missed while disconnected.
//
// `ci` is optional: wired in, it joins the snapshot and gets its own flush flag;
// omitted, the bus behaves exactly as it did with two events.

import type {
  TopologyPayload, SessionStatePayload, CiPayload, SseEventName, SseEvents,
} from './types.ts';

/** The half of an SSE response the bus touches. */
export interface SseClient {
  write: (chunk: string) => unknown;
}

export interface BroadcastDeps {
  /** builds the `topology` half on demand */
  topology: () => TopologyPayload;
  /** builds the `session-state` half on demand */
  sessionState: () => SessionStatePayload;
  /** builds the `ci` half; omitted, the bus has two events */
  ci?: () => CiPayload;
  debounceMs?: number;
}

/** which slow halves to rebuild */
export interface BroadcastDirty {
  topology?: boolean;
  ci?: boolean;
}

function createBroadcast({ topology, sessionState, ci, debounceMs = 80 }: BroadcastDeps) {
  const clients = new Set<SseClient>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let topologyPending = false;
  let ciPending = false;

  function frame<E extends SseEventName>(event: E, data: SseEvents[E]): string { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
  // A dead socket throws here; the request's close handler is what unsubscribes,
  // so one broken client never breaks the fan-out for the others.
  function write(res: SseClient, text: string): void { try { res.write(text); } catch { /* */ } }

  // Send the full snapshot, then join the fan-out. Returns the unsubscribe fn.
  /**
   * @param res  the SSE response
   * @returns unsubscribe
   */
  function subscribe(res: SseClient): () => void {
    write(res, ':ok\n\n');
    write(res, frame('topology', topology()));
    write(res, frame('session-state', sessionState()));
    // The CI half is a cached snapshot, never a lookup — a subscriber gets whatever
    // is known right now (possibly nothing) and the refresh its arrival triggers
    // lands as an ordinary `ci` frame a moment later.
    if (ci) write(res, frame('ci', ci()));
    clients.add(res);
    return () => clients.delete(res);
  }

  // Coalesce a burst into one flush. `topology: true` marks the slow half dirty
  // too — hook traffic must NOT pass it, which is the whole point of the split:
  // a tool call should never trigger a rebuild of every repo's worktree list.
  // `ci: true` is the same deal for the CI half, raised only by server/ci.js when
  // a sweep found something different.
  function schedule({ topology: withTopology = false, ci: withCi = false }: BroadcastDirty = {}) {
    if (withTopology) topologyPending = true;
    if (withCi) ciPending = true;
    if (timer) return;
    timer = setTimeout(flush, debounceMs);
  }

  // Emit whatever is pending. session-state always rides along: it is the cheap
  // half, and including it makes every flush a chance for a client to converge.
  // The CI half does NOT ride along — that is the whole reason it is its own event.
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const withTopology = topologyPending;
    const ciFeed = ciPending && ci ? ci : null;
    topologyPending = false;
    ciPending = false;
    if (!clients.size) return;
    const out: string[] = [];
    if (withTopology) out.push(frame('topology', topology()));
    out.push(frame('session-state', sessionState()));
    if (ciFeed) out.push(frame('ci', ciFeed()));
    for (const res of clients) for (const f of out) write(res, f);
  }

  return { subscribe, schedule, flush, clients };
}

export { createBroadcast };
