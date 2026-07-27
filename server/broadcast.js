'use strict';
// The SSE fan-out. One stream, two named event types, because the state payload
// (server/state.js, docs/api.md) has two very different change rates:
//
//   topology       repos → worktrees → features/groups, plus the config a client
//                  renders its chrome from. Changes when git is rescanned (15 s),
//                  when a worktree or session is created/removed, or when
//                  dev-server discovery finds something new.
//   session-state  { sessions, servers } — the half a Claude Code hook touches.
//                  Every tool call in every session lands here, so it has to stay
//                  small: it is the only thing most broadcasts send.
//
// Both events are FULL REPLACEMENTS of their half, never per-item deltas. The
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
function createBroadcast({ topology, sessionState, debounceMs = 80 }) {
  const clients = new Set();
  let timer = null;
  let topologyPending = false;

  function frame(event, data) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
  // A dead socket throws here; the request's close handler is what unsubscribes,
  // so one broken client never breaks the fan-out for the others.
  function write(res, text) { try { res.write(text); } catch { /* */ } }

  // Send the full snapshot, then join the fan-out. Returns the unsubscribe fn.
  function subscribe(res) {
    write(res, ':ok\n\n');
    write(res, frame('topology', topology()));
    write(res, frame('session-state', sessionState()));
    clients.add(res);
    return () => clients.delete(res);
  }

  // Coalesce a burst into one flush. `topology: true` marks the slow half dirty
  // too — hook traffic must NOT pass it, which is the whole point of the split:
  // a tool call should never trigger a rebuild of every repo's worktree list.
  function schedule({ topology: withTopology = false } = {}) {
    if (withTopology) topologyPending = true;
    if (timer) return;
    timer = setTimeout(flush, debounceMs);
  }

  // Emit whatever is pending. session-state always rides along: it is the cheap
  // half, and including it makes every flush a chance for a client to converge.
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const withTopology = topologyPending;
    topologyPending = false;
    if (!clients.size) return;
    const out = [];
    if (withTopology) out.push(frame('topology', topology()));
    out.push(frame('session-state', sessionState()));
    for (const res of clients) for (const f of out) write(res, f);
  }

  return { subscribe, schedule, flush, clients };
}

module.exports = { createBroadcast };
