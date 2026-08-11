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
 * muxName,title} — into every worktree row AND into every feature/group, while the
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
// The server's own assembler, imported rather than re-implemented: the ordering, the
// empty-chip rule and the label derivation must be one answer, not two. `Link` lives
// there too — it is the shape of an ASSEMBLED link, which is no longer a wire type now
// that the join happens on this side.
import { assemble } from '../../../../server/links';
import type { Link } from '../../../../server/links';

/*
 * The wire contract comes from the SERVER'S OWN types, not a copy.
 *
 * This is the whole reason the client was worth porting. Every shape below is
 * serialized by the daemon and re-derived here; before this import the client
 * re-described them in prose and a change to `TopologyPayload` broke this file
 * SILENTLY. Now it is a compile error.
 *
 * A relative `import type` rather than a `paths` alias, deliberately: `paths` does not
 * merge across `extends`, so declaring one here would clobber the `$lib`/`$app` mappings
 * SvelteKit generates into .svelte-kit/tsconfig.json and pin us to whatever they happen
 * to be today. `server/types.ts` imports nothing, so pulling it across the package
 * boundary drags in no module graph, and `import type` is erased before Vite sees it.
 */
import type {
  CiPayload,
  CiRepo,
  EmbeddedSession,
  Feature,
  FeatureMember,
  Repo,
  Session,
  SessionServers,
  SessionStatePayload,
  TopologyPayload,
  Worktree,
} from '../../../../server/types';

/** The two halves as received, plus the CI half, all optional before first frame. */
export type WorldFrames = Partial<TopologyPayload> & Partial<SessionStatePayload> & Partial<CiPayload>;

/** The stitched world every consumer reads. */
export interface WorldView extends WorldFrames {
  mux: string;
  repos: Repo[];
  sessions: Session[];
  servers: SessionServers;
  features: Feature[];
  groups: Feature[];
  webRepos: string[];
  baseDirs: string[];
  editors: string[];
  ci: Record<string, CiRepo[]>;
}

/** The shape every consumer can rely on before (and between) frames. */
const EMPTY = {
  mux: '…',
  repos: [] as Repo[],
  sessions: [] as Session[],
  servers: {} as SessionServers,
  sources: [] as TopologyPayload['sources'],
  features: [] as Feature[],
  groups: [] as Feature[],
  webRepos: [] as string[],
  baseDirs: [] as string[],
  editors: [] as string[],
  runConfigs: {} as TopologyPayload['runConfigs'],
  config: {} as TopologyPayload['config'],
  ci: {} as Record<string, CiRepo[]>,
};

/**
 * Re-project the live `sessions` onto every embedded copy, keyed by id. Agent state
 * changes orders of magnitude more often than topology does, so without this a Fleet
 * row shows the state from the last topology rebuild (up to ~15 s stale) and a closed
 * session lingers on its worktree forever.
 *
 * Pure: returns a new object and never writes into the frames it reads.
 */
export function stitchSessions(next: WorldView): WorldView {
  const byId = new Map<string, Session>((next.sessions || []).map((s) => [s.id, s]));
  const fresh = (embedded: EmbeddedSession | null | undefined): EmbeddedSession | null => {
    if (!embedded) return null;
    const s = byId.get(embedded.id);
    return s ? { id: s.id, state: s.state, activity: s.activity, muxName: s.muxName, title: s.title } : null;
  };
  // A feature's members are serialized separately from repos[].worktrees, so on this
  // side they are distinct objects and need the same projection.
  const feat = (list: Feature[]): Feature[] =>
    (list || []).map((f) => ({
      ...f,
      session: fresh(f.session),
      members: (f.members || []).map((m: FeatureMember) =>
        m && !('missing' in m && m.missing) ? { ...m, session: fresh((m as Worktree).session) } : m,
      ),
    }));
  return {
    ...next,
    repos: (next.repos || []).map((r) => ({
      ...r,
      worktrees: (r.worktrees || []).map((w) => ({ ...w, session: fresh(w.session) })),
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
  topology = $state.raw<Partial<TopologyPayload>>({});
  /** Last `session-state` frame, exactly as received. */
  sessionHalf = $state.raw<Partial<SessionStatePayload>>({});
  /** Last `ci` frame, exactly as received. */
  ciHalf = $state.raw<Partial<CiPayload>>({});
  /** True once the first frame of either kind has landed. */
  connected = $state(false);
  /** Set when the stream has errored and not yet re-delivered a frame. */
  streamError = $state('');

  /** The stitched view. Recomputed from the two pristine halves on every frame. */
  view = $derived(stitchSessions({ ...EMPTY, ...this.topology, ...this.sessionHalf, ...this.ciHalf }));

  get mux(): string {
    return this.view.mux;
  }
  get repos(): Repo[] {
    return this.view.repos;
  }
  get sessions(): Session[] {
    return this.view.sessions;
  }
  get servers(): SessionServers {
    return this.view.servers;
  }
  get sources(): TopologyPayload['sources'] {
    return this.view.sources ?? [];
  }
  get features(): Feature[] {
    return this.view.features;
  }
  get groups(): Feature[] {
    return this.view.groups;
  }
  get webRepos(): string[] {
    return this.view.webRepos;
  }
  /** The scanned root folders, in config order — what the root switcher offers. */
  get baseDirs(): string[] {
    return this.view.baseDirs ?? [];
  }
  /** sessionId → the repos array `GET /sessions/:id/ci` would answer with. */
  get ci(): Record<string, CiRepo[]> {
    return this.view.ci;
  }

  session(id: string): Session | null {
    return this.sessions.find((s) => s.id === id) || null;
  }

  /**
   * The colour tag of the feature this session drives, if it has one.
   *
   * The tag belongs to the FEATURE, and the dock is handed a session — so the lookup goes
   * the other way, through whichever feature or manual group claims it. Worth doing
   * rather than putting a colour on the session: the tag has to survive the session being
   * stopped and started again, and a session-side copy would not.
   */
  featureFor(sessionId: string): Feature | null {
    if (!sessionId) return null;
    return (
      this.view.features.find((f) => f.session?.id === sessionId) ||
      this.view.groups.find((f) => f.session?.id === sessionId) ||
      null
    );
  }

  featureColorFor(sessionId: string): string {
    return this.featureFor(sessionId)?.color || '';
  }

  /**
   * A feature's links, joined from the two halves that carry them.
   *
   * The ticket and the pins ride the TOPOLOGY frame (they are config, and change when you
   * change them); the merge requests ride the CI frame (they change when a pipeline
   * ticks). Joining here rather than on the server is what keeps a pipeline tick from
   * rebroadcasting the whole repo shape — the same reason sessions are stitched rather
   * than embedded. `assemble()` is the server's own module, so both sides cannot drift.
   */
  /** featureName → its ticket's workflow status, when a tracker could tell us. */
  get taskStatus(): Record<string, { label: string; done: boolean }> {
    return this.view.taskStatus || {};
  }

  linksFor(feature: Feature | null): Link[] {
    if (!feature) return [];
    const sessionId = feature.session?.id || '';
    return assemble({
      ticketUrl: feature.ticket,
      session: sessionId ? this.session(sessionId) : null,
      ci: sessionId ? this.view.ci[sessionId] || [] : [],
      repos: (feature.members || [])
        .map((m) => (m && 'repo' in m ? m.repo : ''))
        .filter((r): r is string => !!r),
      pins: feature.pins,
      providers: this.view.linkProviders,
    }).map((l) =>
      // The ticket chip carries its status. Only the ticket: a merge request has its own
      // state already, and a pinned link has no workflow to be in.
      l.kind === 'ticket' && this.taskStatus[feature.name]
        ? { ...l, sub: this.taskStatus[feature.name].label }
        : l,
    );
  }
}

export const world = new World();

/**
 * Subscribe to the stream. Returns a teardown fn, so a layout can own the connection
 * for the lifetime of the app and nothing leaks on HMR.
 *
 * `onSessionFrame` runs with the incoming frame BEFORE it is swapped in, which is what
 * lets notification code diff new state against the previous one.
 */
export interface StreamHooks {
  onSessionFrame?: (frame: SessionStatePayload) => void;
}

/**
 * How long without a single byte before the stream is assumed dead.
 *
 * The daemon heartbeats every 25s, so silence for more than twice that is not a quiet
 * period — it is a connection that is gone without having said so.
 */
const SILENCE_MS = 60_000;

export function connectStream(hooks: StreamHooks = {}): () => void {
  /*
   * The browser's own reconnect is NOT enough, in two distinct ways — and both present
   * identically to the user: you click something, nothing happens, and a page refresh
   * fixes it.
   *
   * 1. A HALF-OPEN socket. Sleep the laptop, change network, and the TCP connection is
   *    gone while the EventSource still reports OPEN. No error fires, because from the
   *    browser's point of view nothing has failed — it is simply waiting. It waits
   *    forever. This is the common one for a tool that lives in a background tab.
   *
   * 2. A PERMANENT close. Per the spec, a reconnect that receives a non-200 status or the
   *    wrong content-type must FAIL THE CONNECTION rather than retry — so a reconnect
   *    landing mid-restart can kill the stream for good, while `onerror` cheerfully says
   *    "reconnecting" forever. That message was a claim the code could not back.
   *
   * So: a silence watchdog for the first, and a readyState check for the second.
   */
  let ev: EventSource | null = null;
  let lastByte = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  /** Backoff, so a daemon that is down does not get a request per second. */
  let attempt = 0;

  const open = () => {
    if (closed) return;
    // EventSource cannot set headers, so the boot token rides in the query string.
    ev = new EventSource(`/api/v1/events${tokenQuery('?')}`);
    wire(ev);
  };

  const reconnect = (why: string) => {
    if (closed || retry) return;
    world.streamError = why;
    try {
      ev?.close();
    } catch {
      /* already gone */
    }
    ev = null;
    // 1s, 2s, 4s… capped. A tab that has been asleep for hours must not stampede.
    const wait = Math.min(1000 * 2 ** attempt, 15_000);
    attempt += 1;
    retry = setTimeout(() => {
      retry = null;
      open();
    }, wait);
  };

  const wire = (src: EventSource) => {
    const apply = (half: 'topology' | 'sessions' | 'ci') => (e: MessageEvent) => {
      lastByte = Date.now();
      // `any`, not `unknown`: the three branches below hand it straight to $state.raw
      // fields typed by the wire contract, and the daemon is the only writer of this
      // stream. Naming the type is what stops it being an *implicit* any.
      let frame: any;
      try {
        frame = JSON.parse(e.data);
      } catch {
        return;
      }
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
      attempt = 0; // a frame arrived, so the backoff has served its purpose
    };

    src.addEventListener('topology', apply('topology'));
    src.addEventListener('session-state', apply('sessions'));
    // The daemon pushes CI (server/ci.ts decides when to look and only emits a frame when
    // the snapshot changed). Dropping this event is what forced the serverbar to poll.
    src.addEventListener('ci', apply('ci'));
    // Comments (`:hb`) fire no event, but they DO keep the socket warm; the watchdog below
    // is what notices when they stop.
    src.addEventListener('open', () => {
      lastByte = Date.now();
      world.streamError = '';
    });

    src.onerror = () => {
      /*
       * CLOSED means the browser has given up permanently — it will not retry, whatever the
       * old message claimed. CONNECTING means it is retrying on its own and there is nothing
       * to do but say so.
       */
      if (src.readyState === EventSource.CLOSED) reconnect('reconnecting…');
      else world.streamError = 'stream interrupted — reconnecting';
    };
  };

  open();

  /*
   * The silence watchdog. This is the half-open case: no error ever fires, the stream
   * reports OPEN, and nothing arrives. Only elapsed time can tell.
   */
  watchdog = setInterval(() => {
    if (closed || retry) return;
    if (Date.now() - lastByte > SILENCE_MS) {
      lastByte = Date.now(); // do not re-fire every tick while the reconnect is in flight
      reconnect('connection went quiet — reconnecting…');
    }
  }, 15_000);

  return () => {
    closed = true;
    if (watchdog) clearInterval(watchdog);
    if (retry) clearTimeout(retry);
    try {
      ev?.close();
    } catch {
      /* already closed */
    }
  };
}

/** The minimum a row needs for `webAppsFor` to judge it — a worktree or a session repo. */
export interface ServableRow {
  repo: string;
  running?: boolean;
  ports?: number[];
}

export interface WebApp {
  repo: string;
  port: number;
}

/**
 * The browsable frontends of a feature/session: every web repo (config.webRepos) that
 * is running with a discovered port. One "Open <repo> ↗" button per entry.
 */
export function webAppsFor(list: ServableRow[]): WebApp[] {
  const web = new Set(world.webRepos || []);
  const out: WebApp[] = [];
  for (const r of list || []) {
    // Bind the array before testing it: `(r.ports || []).length` does not narrow
    // `r.ports` itself, so indexing it afterwards is still possibly-undefined.
    const ports = r.ports || [];
    if (web.has(r.repo) && r.running && ports.length) out.push({ repo: r.repo, port: ports[0] });
  }
  return out;
}

/**
 * The URL of a dev server this app is listening on. THE one builder of it.
 *
 * `localhost`, never `127.0.0.1`, and the difference is not cosmetic. Vite — and every
 * other server on a modern Node — binds the loopback interface by family, and on this
 * machine that means `[::1]` alone:
 *
 *     $ lsof -nP -iTCP:3031 -sTCP:LISTEN
 *     node ... TCP [::1]:3031 (LISTEN)
 *     $ curl http://127.0.0.1:3031/   → connection refused
 *     $ curl http://localhost:3031/   → 200
 *
 * So a hard-coded IPv4 literal is refused by a server that is running perfectly well.
 * `localhost` resolves to whichever family bound, which is the only form that works for
 * both. This mattered because there were TWO builders of this URL that disagreed —
 * `openApp` said localhost, DockHead's port chip said 127.0.0.1 — and the chip is the one
 * you actually click, so a running frontend read as dead.
 */
export function appUrl(port: number): string {
  return `http://localhost:${port}`;
}

export function openApp(port: number): void {
  window.open(appUrl(port), '_blank', 'noopener');
}
