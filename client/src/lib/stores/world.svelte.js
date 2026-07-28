/*
 * The SSE-backed state layer.
 *
 * `GET /api/events` carries THREE named events, each a full replacement of one half of
 * the state payload (docs/api.md):
 *
 *   topology       repos, worktrees, features, groups, sources, config — rebuilt on a
 *                  git rescan or a real mutation, so it arrives rarely.
 *   session-state  { sessions, servers } — re-sent on every Claude hook, i.e. every
 *                  tool call, which is why it is the small half.
 *   ci             { ci } — sessionId → the PR/MR + checks summary per repo. Its own
 *                  event because it moves on the order of minutes: riding along with
 *                  the hook half would re-send an unchanged payload thousands of times.
 *
 * One of each is written before the client joins the fan-out, so both a first load and
 * the EventSource's own reconnect start from a complete snapshot.
 *
 * ---------------------------------------------------------------------------------
 * THE TRAP, and why this module is shaped the way it is.
 *
 * The topology half embeds a trimmed copy of the driving session — {id,state,activity,
 * muxName} — into every worktree row AND into every feature/group, while the
 * authoritative list lives in `sessions`, which belongs to the *other* half. Those
 * embedded copies are frozen at the moment the topology was built.
 *
 * So there are two failure modes, and one shape that avoids both:
 *
 *   - Patch a single merged object in place, and the `topology` frame that arrives
 *     first (on connect, and on every rescan) overwrites the world with rows whose
 *     embedded session decoration is stale — or, if you stitched into the previous
 *     object, gone. Nothing later restores it, because the next `session-state` frame
 *     only carries `sessions`/`servers`; it never re-sends the rows.
 *   - Stitch destructively into the stored frame, and the *next* projection runs
 *     against already-rewritten input.
 *
 * Therefore: keep each half VERBATIM exactly as received, and DERIVE the view from the
 * pair on every frame. `stitchSessions` is a pure function from (frames) → world, so it
 * always runs against the ids the server actually embedded, and frame order stops
 * mattering. This matches `lastTopology` / `lastSessions` / `stitchSessions` in
 * public/app.js, which is the implementation that gets it right.
 */

import { tokenQuery } from '$lib/api.js';

/** The shape every consumer can rely on before (and between) frames. */
const EMPTY = {
  mux: '…',
  repos: /** @type {any[]} */ ([]),
  sessions: /** @type {any[]} */ ([]),
  servers: /** @type {Record<string, any>} */ ({}),
  sources: /** @type {any[]} */ ([]),
  features: /** @type {any[]} */ ([]),
  groups: /** @type {any[]} */ ([]),
  webRepos: /** @type {string[]} */ ([]),
  baseDirs: /** @type {string[]} */ ([]),
  editors: /** @type {string[]} */ ([]),
  runConfigs: /** @type {Record<string, any>} */ ({}),
  config: /** @type {Record<string, any>} */ ({}),
  ci: /** @type {Record<string, any[]>} */ ({}),
};

/**
 * Re-project the live `sessions` onto every embedded copy, keyed by id. Agent state
 * changes orders of magnitude more often than topology does, so without this a Fleet
 * row shows the state from the last topology rebuild (up to ~15 s stale) and a closed
 * session lingers on its worktree forever.
 *
 * Pure: returns a new object and never writes into the frames it reads.
 * @param {any} next
 */
export function stitchSessions(next) {
  const byId = new Map((next.sessions || []).map((/** @type {any} */ s) => [s.id, s]));
  /** @param {any} embedded */
  const fresh = (embedded) => {
    if (!embedded) return null;
    const s = byId.get(embedded.id);
    return s ? { id: s.id, state: s.state, activity: s.activity, muxName: s.muxName } : null;
  };
  // A feature's members are serialized separately from repos[].worktrees, so on this
  // side they are distinct objects and need the same projection.
  /** @param {any[]} list */
  const feat = (list) => (list || []).map((f) => ({
    ...f,
    session: fresh(f.session),
    members: (f.members || []).map((/** @type {any} */ m) => (m && !m.missing ? { ...m, session: fresh(m.session) } : m)),
  }));
  return {
    ...next,
    repos: (next.repos || []).map((/** @type {any} */ r) => ({
      ...r,
      worktrees: (r.worktrees || []).map((/** @type {any} */ w) => ({ ...w, session: fresh(w.session) })),
    })),
    features: feat(next.features),
    groups: feat(next.groups),
  };
}

/**
 * Both halves, kept verbatim, plus the derived world. `$state.raw` because a frame is
 * always replaced wholesale — no part of it is ever mutated, so deep proxying would buy
 * nothing and cost a walk of the whole payload on every tool call.
 */
class World {
  /** Last `topology` frame, exactly as received. */
  topology = $state.raw(/** @type {any} */ ({}));
  /** Last `session-state` frame, exactly as received. */
  sessionHalf = $state.raw(/** @type {any} */ ({}));
  /** Last `ci` frame, exactly as received. */
  ciHalf = $state.raw(/** @type {any} */ ({}));
  /** True once the first frame of either kind has landed. */
  connected = $state(false);
  /** Set when the stream has errored and not yet re-delivered a frame. */
  streamError = $state('');

  /** The stitched view. Recomputed from the two pristine halves on every frame. */
  view = $derived(stitchSessions({ ...EMPTY, ...this.topology, ...this.sessionHalf, ...this.ciHalf }));

  get mux() { return this.view.mux; }
  get repos() { return this.view.repos; }
  get sessions() { return this.view.sessions; }
  get servers() { return this.view.servers; }
  get sources() { return this.view.sources; }
  get features() { return this.view.features; }
  get groups() { return this.view.groups; }
  get webRepos() { return this.view.webRepos; }
  /** sessionId → the repos array `GET /sessions/:id/ci` would answer with. */
  get ci() { return this.view.ci; }

  /** @param {string} id */
  session(id) { return this.sessions.find((/** @type {any} */ s) => s.id === id) || null; }
}

export const world = new World();

/**
 * Subscribe to the stream. Returns a teardown fn, so a layout can own the connection
 * for the lifetime of the app and nothing leaks on HMR.
 *
 * @param {{ onSessionFrame?: (frame: any) => void }} [hooks]
 *   `onSessionFrame` runs with the incoming frame BEFORE it is swapped in, which is
 *   what lets notification code diff new state against the previous one.
 */
export function connectStream(hooks = {}) {
  // EventSource cannot set headers, so the boot token rides in the query string.
  const ev = new EventSource(`/api/events${tokenQuery('?')}`);

  /** @param {'topology'|'sessions'|'ci'} half */
  const apply = (half) => (/** @type {MessageEvent} */ e) => {
    let frame;
    try { frame = JSON.parse(e.data); } catch { return; }
    if (half === 'sessions') {
      hooks.onSessionFrame?.(frame); // diff BEFORE swapping in
      world.sessionHalf = frame;
    } else if (half === 'ci') {
      world.ciHalf = frame;
    } else {
      world.topology = frame;
    }
    world.connected = true;
    world.streamError = '';
  };

  ev.addEventListener('topology', apply('topology'));
  ev.addEventListener('session-state', apply('sessions'));
  // The daemon pushes CI (server/ci.js decides when to look and only emits a frame when
  // the snapshot changed). Dropping this event is what forced the serverbar to poll.
  ev.addEventListener('ci', apply('ci'));
  // The browser reconnects on its own and the server re-snapshots, so this is only a
  // surface for the UI to say "stale" while that is happening.
  ev.onerror = () => { world.streamError = 'stream interrupted — reconnecting'; };

  return () => { try { ev.close(); } catch { /* already closed */ } };
}

/**
 * The browsable frontends of a feature/session: every web repo (config.webRepos) that
 * is running with a discovered port. One "Open <repo> ↗" button per entry.
 * @param {any[]} list
 */
export function webAppsFor(list) {
  const web = new Set(world.webRepos || []);
  /** @type {{repo:string, port:number}[]} */
  const out = [];
  for (const r of list || []) {
    if (web.has(r.repo) && r.running && (r.ports || []).length) out.push({ repo: r.repo, port: r.ports[0] });
  }
  return out;
}

/** @param {number} port */
export function openApp(port) {
  window.open(`http://localhost:${port}`, '_blank', 'noopener');
}
