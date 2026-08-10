// The unified state payload — every worktree decorated with its discovered dev
// server and its driving session, grouped into features. One shape serves
// /api/state, every SSE frame, SwiftBar and Alfred, so it is the contract other
// clients build against (docs/api.md).
//
// It is assembled from two halves on purpose. `topology()` is the slow-moving
// shape (repos → worktrees → features) and `sessionState()` is the live
// per-session slice. The SSE stream broadcasts them as two named event types at
// their own rates (server/broadcast.ts) — the session half on every Claude hook,
// the topology half only when the shape actually changes. buildState() merges
// them for the callers that want the whole world at once: GET /state, SwiftBar,
// Alfred, resolveGroup.
import { computeFeatures } from './features.ts';
import { SHIPPED_PROVIDERS } from './links.ts';
import type { ComputedFeature } from './features.ts';
import { createRealpathCache } from './util.ts';
import * as sources from './sources/index.ts';
import type { RunningServer } from './servers.ts';
import type { Identity } from './identity.ts';
import type {
  Config,
  EmbeddedSession,
  Feature,
  FeatureMember,
  PartialDeep,
  ResolvedFeature,
  Run,
  Session,
  SessionServers,
  SessionStatePayload,
  StatePayload,
  TopologyPayload,
  Worktree,
} from './types.ts';

// The collaborators are typed by the surface this file touches, not by the concrete
// classes server.ts hands over — the same rule server/orchestrator.ts and
// server/routes-review.ts follow, and what lets test/state.test.ts drive the whole
// payload with four-method fakes instead of booting a manager and an lsof scan.

/** The SessionManager, typed by the two lookups the payload needs. */
export interface StateManager {
  all(): Session[];
  /** Sessions keyed by their worktree path, resolved through `resolve`. */
  sessionIndex(resolve?: (p: string) => string): Map<string, Session>;
}

/** Servers, typed by what decorating a worktree and pricing a slot needs. */
export interface StateServers {
  /** feature name → concurrency slot. */
  slots: Map<string, number>;
  /** Non-null when the repo has a launchable dev-server command. */
  startCfg(repo: string): unknown;
  isSlotted(repo: string): boolean;
  decorate(
    worktree: Pick<Worktree, 'path' | 'repo'>,
    running: Map<string, RunningServer>,
  ): Pick<Worktree, 'running' | 'pid' | 'ports' | 'canStart'>;
  /**
   * The shared feature-identity resolver. Optional: `identity` may be injected
   * directly instead, and computeFeatures() falls back to the `basename` strategy
   * when neither is supplied.
   */
  identity?: Identity;
}

/** A repo as the scan cache reports it, narrowed to the fields topology() reads. */
export interface StateRepo {
  name: string;
  path: string;
  defaultBranch: string;
  worktrees: Array<{
    path: string;
    name: string;
    branch: string | null;
    isMain: boolean;
    detached: boolean;
    merged: boolean;
  }>;
}

// Drop the undefined-valued keys from a dictionary read off a PartialDeep config.
//
// `PartialDeep` maps `?` over every key, and for a `Record<string, V>` that means
// the index signature itself becomes `V | undefined` — so a dictionary read off a
// config is not directly assignable to the payload's `Record<string, V>`. This is
// what the payload actually puts on the wire either way: JSON.stringify omits an
// undefined value, so filtering here is the shape the client already receives,
// stated rather than asserted.
function definedValues<V>(dict: Record<string, V | undefined> | undefined): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(dict || {})) if (v !== undefined) out[k] = v;
  return out;
}

/** The multiplexer, typed by the one member the payload reads. */
export interface StateMux {
  name: string;
}

/**
 * A row `conflictsFor()` can judge. `running` is OPTIONAL because the callers that
 * hand it a list do not all promise the field: server/orchestrator.ts types its
 * members by what its own routes read, and an absent `running` is simply not
 * running — which is what the truthiness test below already meant.
 */
export interface ConflictCandidate {
  repo: string;
  path: string;
  running?: boolean;
}

export interface StateDeps {
  /** Only a handful of keys are read, each with a fallback. */
  cfg: PartialDeep<Config>;
  manager: StateManager;
  servers: StateServers;
  /** null when no multiplexer was found — the payload reports 'none'. */
  mux: StateMux | null;
  /** The repo scan cache, re-read per call. */
  repos: () => StateRepo[];
  /** The lsof discovery map, re-read per call. */
  running: () => Map<string, RunningServer>;
  /** Finite command runs, newest first — see server/runner.ts. */
  runs: () => Run[];
  /**
   * Defaults to `servers.identity` — the two must agree, so sharing one resolver
   * is the point.
   */
  identity?: Identity | null;
}

export interface State {
  buildState(): Promise<StatePayload>;
  topology(): TopologyPayload;
  sessionState(): SessionStatePayload;
  prunePaths(): void;
  resolveGroup(name: string): Promise<{ group: ResolvedFeature | null; flat: Worktree[] }>;
  conflictsFor<W extends ConflictCandidate>(member: Pick<Worktree, 'repo' | 'path'>, flat: W[]): W[];
}

// `repos` and `running` are getters, not values: the repo scan cache and the lsof
// discovery map are replaced wholesale on every refresh, so a captured reference
// would go stale the first time either one is rescanned.
function createState({ cfg, manager, servers, mux, repos, running, runs, identity }: StateDeps): State {
  // The feature-identity resolver is shared with servers.ts on purpose: the
  // grouping below and the concurrency slot key must be the same answer.
  const ident = identity || servers.identity;
  // Both halves compare worktree paths that reach us from three different sources
  // (the git scan, a session's stored paths, lsof), so every comparison resolves
  // symlinks first. One cache serves both halves; prunePaths() invalidates it.
  const paths = createRealpathCache();

  function baseDirOf(repoPath: string): string {
    return (cfg.baseDirs || []).find((b) => repoPath.startsWith(b)) || '';
  }

  // A member that is on disk AND driven by a session. A manual group can name a
  // worktree that has since been removed, and those arrive as { missing, ref }
  // stubs with no `session` to read at all.
  function hasSession(m: FeatureMember): m is Worktree & { session: EmbeddedSession } {
    return !!m && !m.missing && !!m.session;
  }

  // Repos, their worktrees (decorated with server + session), the features/groups
  // those worktrees roll up into, and the config a client renders its chrome from.
  function topology(): TopologyPayload {
    const active = running();
    // One pass over the sessions, then a map lookup per worktree — not a scan of
    // every session per worktree.
    const sessionsByPath = manager.sessionIndex(paths.resolve);
    const reposOut: TopologyPayload['repos'] = [];
    const flat: Worktree[] = [];
    for (const repo of repos()) {
      const wts: Worktree[] = [];
      for (const w of repo.worktrees) {
        const dec = servers.decorate({ path: w.path, repo: repo.name }, active);
        const sess = w.isMain ? null : sessionsByPath.get(paths.resolve(w.path)) || null;
        const wt: Worktree = {
          repo: repo.name,
          wtname: w.name,
          branch: w.branch,
          path: w.path,
          isMain: w.isMain,
          detached: w.detached,
          merged: w.merged,
          baseBranch: repo.defaultBranch,
          baseDir: baseDirOf(repo.path),
          // Spread, not a hand-picked list. This was `running, pid, ports, canStart`,
          // so `depsMissing` — added later — was computed by decorate() and then
          // silently dropped here: the rail's "deps missing" pill could never render,
          // and nothing failed, because an absent field reads as false everywhere.
          // Spreading means the next field decorate() learns arrives on its own.
          ...dec,
          session: sess
            ? {
                id: sess.id,
                state: sess.state,
                activity: sess.activity,
                muxName: sess.muxName,
                title: sess.title,
              }
            : null,
        };
        wts.push(wt);
        flat.push(wt);
      }
      reposOut.push({
        name: repo.name,
        repo: repo.name,
        path: repo.path,
        defaultBranch: repo.defaultBranch,
        worktrees: wts,
      });
    }
    const { features, groups } = computeFeatures(flat, cfg.groups || [], ident);
    // one session per feature: surface the single driving session on the feature,
    // plus its concurrency slot (0,1,2…) when one is allocated — powers the Fleet badge.
    // computeFeatures() deliberately returns `ComputedFeature` (a Feature minus
    // `session`) — attaching it is this function's job, and the split is what keeps
    // features.ts unaware of sessions.
    const withSession = (f: ComputedFeature): Feature => {
      const m = (f.members || []).find(hasSession);
      const out: Feature = { ...f, session: m ? m.session : null };
      const slot = servers.slots.get(f.name);
      if (slot !== undefined) out.slot = slot;
      const color = (cfg.featureColors || {})[f.name];
      if (color) out.color = color;
      // Raw link config only. The MR chips are joined in on the client from the `ci`
      // frame — see the note on Feature.ticket.
      const lk = (cfg.featureLinks || {})[f.name];
      if (lk?.ticket) out.ticket = lk.ticket;
      if (lk?.pins?.length) out.pins = lk.pins;
      return out;
    };
    return {
      mux: mux ? mux.name : 'none',
      config: { port: cfg.web?.port ?? 0, configFile: cfg._file || '' },
      runningTotal: flat.filter((w) => w.running).length,
      baseDirs: cfg.baseDirs || [],
      editors: Object.keys(cfg.editors || {}),
      // User entries FIRST, so one can override a shipped recogniser.
      linkProviders: [...(cfg.linkProviders || []), ...SHIPPED_PROVIDERS],
      defaultEditor: cfg.defaultEditor || '',
      webRepos: cfg.webRepos || [],
      runConfigs: definedValues(cfg.runConfigs),
      sources: sources.enabled(cfg),
      repos: reposOut,
      features: features.map(withSession),
      groups: groups.map(withSession),
    };
  }

  // The sessions plus, per session, the dev-server state of every repo it owns
  // (its shared workspace) — the half that changes on every Claude hook.
  function sessionState(): SessionStatePayload {
    const active = running();
    const sessions = manager.all();
    const serversById: SessionServers = {};
    for (const s of sessions) {
      const owned = (s.repos || []).filter((r): r is typeof r & { worktreePath: string } => !!r.worktreePath);
      const list = owned.length
        ? owned
        : s.worktreePath
          ? [{ repo: s.repoName, worktreePath: s.worktreePath }]
          : [];
      if (list.length) {
        serversById[s.id] = {
          repos: list.map((r) => {
            /*
             * `...decorate()`, not a hand-picked list.
             *
             * This re-implemented `canStart` as "a start command exists", which is what
             * it USED to mean; decorate() redefined it as "starting this will work"
             * (configured && !depsMissing) and added the three fields that explain a
             * false. So the same worktree said "deps missing, cannot start" on the rail
             * and offered an enabled Start button here — and pressing it spawned a
             * command that died immediately, with no field on this half able to say why.
             * Spreading is also what stops the next added field going missing on one
             * side only; topology() has spread for exactly that reason since a
             * hand-picked list dropped `depsMissing` once already.
             */
            return {
              repo: r.repo,
              worktreePath: r.worktreePath,
              ...servers.decorate({ repo: r.repo, path: r.worktreePath }, active),
            };
          }),
        };
      }
    }
    return { sessions, servers: serversById, runs: runs() };
  }

  // Superset of worktree-dash's contract. Async because every caller awaits it and
  // the halves may need to do I/O later.
  async function buildState(): Promise<StatePayload> {
    return { ...topology(), ...sessionState() };
  }

  // Invalidate the realpath cache against reality. The repo scan is the authority
  // on which worktrees exist and the session list on which paths are driven, so a
  // path that neither still names is exactly the signal a cached resolution needs:
  // a worktree removed now and recreated later must not resolve through its old
  // entry. server.ts calls this after every rescan — the 15 s timer and every
  // worktree mutation — so invalidation happens whether or not anyone is
  // listening on SSE, and never depends on who asked for a path recently.
  function prunePaths(): void {
    const live = new Set<string>(manager.sessionIndex((p: string) => p).keys()); // raw, unresolved
    for (const repo of repos()) for (const w of repo.worktrees) live.add(w.path);
    paths.retain(live);
  }

  // A member that is really on disk. A manual group can name a worktree that has
  // since been removed, and those arrive as { missing, ref } stubs.
  function present(m: FeatureMember): m is Worktree {
    return !!m && !m.missing;
  }

  // Resolve a feature/group by name from current state; drop missing members.
  async function resolveGroup(name: string): Promise<{ group: ResolvedFeature | null; flat: Worktree[] }> {
    const st = await buildState();
    const g =
      (st.features || []).find((x) => x.name === name) || (st.groups || []).find((x) => x.name === name);
    if (!g) return { group: null, flat: [] };
    const flat = st.repos.flatMap((r) => r.worktrees);
    return { group: { ...g, members: g.members.filter(present) }, flat };
  }

  // running worktrees in the same repo at a different path (must stop to switch) —
  // but a concurrency-slotted repo runs on its own offset ports per feature, so
  // running it in another worktree is NOT a conflict (no stop & switch needed).
  /** @param flat  every worktree in every repo */
  function conflictsFor<W extends ConflictCandidate>(
    member: Pick<Worktree, 'repo' | 'path'>,
    flat: W[],
  ): W[] {
    if (servers.isSlotted(member.repo)) return [];
    return flat.filter((w) => w.repo === member.repo && w.path !== member.path && w.running);
  }

  return { buildState, topology, sessionState, prunePaths, resolveGroup, conflictsFor };
}

export { createState };
