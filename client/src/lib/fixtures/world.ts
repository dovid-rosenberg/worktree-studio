/*
 * One world, built from the server's own types.
 *
 * Every component test used to construct its own topology and session half by assigning
 * into the store and casting through `as never` to get past the types. That made writing
 * the next test expensive — you had to invent a universe before you could ask a question —
 * and it made every fixture free to drift from what the daemon actually sends, because
 * the cast silenced exactly the check that would have caught it.
 *
 * So: complete defaults, typed, overridden by exception. `makeWorld()` returns the three
 * pristine halves the store holds, and `install()` puts them there. No cast at any call
 * site; if the wire shape changes, these stop compiling, which is the entire point.
 *
 * Used by the component tests AND by /gallery, so a state you can look at in the browser
 * is a state a test can assert on.
 */
import type {
  CiRepo,
  EmbeddedSession,
  Feature,
  Repo,
  Session,
  SessionRepo,
  TopologyPayload,
  Worktree,
} from '../../../../server/types';

/** Deep-ish override: top-level keys replace, which is all any fixture has needed. */
type Over<T> = Partial<T>;

export const REPO = 'accept-blue';
export const FEATURE = 'token-race-fix';
export const BRANCH = 'fix/token-create-race';

/** One worktree row, decorated exactly as `servers.decorate()` leaves it. */
export function member(over: Over<Worktree> = {}): Worktree {
  const repo = over.repo ?? REPO;
  const wtname = over.wtname ?? FEATURE;
  return {
    repo,
    wtname,
    branch: BRANCH,
    path: `/code/${repo}/.worktrees/${wtname}`,
    isMain: false,
    detached: false,
    merged: false,
    baseBranch: 'develop',
    baseDir: '/code',
    running: false,
    pid: null,
    ports: [],
    canStart: true,
    session: null,
    ...over,
  } as Worktree;
}

/** One entry of a session's `repos` — a worktree the agent can actually write to. */
export function sessionRepo(over: Over<SessionRepo> = {}): SessionRepo {
  const repo = over.repo ?? REPO;
  return {
    repo,
    repoPath: `/code/${repo}`,
    worktree: FEATURE,
    worktreePath: `/code/${repo}/.worktrees/${FEATURE}`,
    branch: BRANCH,
    primary: true,
    ...over,
  } as SessionRepo;
}

export function session(over: Over<Session> = {}): Session {
  return {
    id: 's1',
    title: FEATURE,
    source: 'text',
    sourceId: '',
    sourceUrl: '',
    repoName: REPO,
    repoPath: `/code/${REPO}`,
    home: `/code/${REPO}/.worktrees/${FEATURE}`,
    worktree: FEATURE,
    worktreePath: `/code/${REPO}/.worktrees/${FEATURE}`,
    branch: BRANCH,
    feature: FEATURE,
    repos: [sessionRepo()],
    pendingRepos: [],
    suggestedBranch: BRANCH,
    suggestedName: FEATURE,
    muxName: `wts-${FEATURE}-abcd1234`,
    claudeSessionId: 'c1',
    state: 'working',
    activity: 'Edit file',
    tabs: [{ id: '0', title: 'claude' }],
    seed: '',
    active: true,
    createdAt: 0,
    promotedAt: 0,
    ...over,
  } as Session;
}

/** The frozen copy of a session that the topology embeds into a feature. */
export function embedded(over: Over<EmbeddedSession> = {}): EmbeddedSession {
  return {
    id: 's1',
    state: 'working',
    activity: 'Edit file',
    muxName: `wts-${FEATURE}-abcd1234`,
    title: FEATURE,
    ...over,
  } as EmbeddedSession;
}

export function feature(over: Over<Feature> = {}): Feature {
  return {
    name: FEATURE,
    auto: true,
    members: [member()],
    session: null,
    ...over,
  } as Feature;
}

export function repo(over: Over<Repo> = {}): Repo {
  const name = over.name ?? REPO;
  return {
    name,
    repo: name,
    path: `/code/${name}`,
    defaultBranch: 'develop',
    worktrees: [member({ repo: name })],
    ...over,
  } as Repo;
}

/** The three pristine halves the store holds, exactly as the daemon sends them. */
export interface FixtureWorld {
  topology: TopologyPayload;
  sessionHalf: { sessions: Session[]; servers: Record<string, unknown> };
  ciHalf: { ci: Record<string, CiRepo[]> };
}

export function makeWorld(
  over: {
    features?: Feature[];
    groups?: Feature[];
    sessions?: Session[];
    repos?: Repo[];
    ci?: Record<string, CiRepo[]>;
    topology?: Over<TopologyPayload>;
  } = {},
): FixtureWorld {
  const features = over.features ?? [feature()];
  return {
    topology: {
      mux: 'tmux',
      config: { port: 7788, configFile: '/cfg.json', buildId: 'fixture0build' },
      runningTotal: 0,
      baseDirs: ['/code'],
      editors: ['WebStorm'],
      linkProviders: [],
      defaultEditor: 'WebStorm',
      webRepos: [],
      runConfigs: {},
      sources: [],
      repos: over.repos ?? [repo()],
      features,
      groups: over.groups ?? [],
      splitFeatures: [],
      sessionRepoGaps: [],
      ...over.topology,
    } as TopologyPayload,
    sessionHalf: { sessions: over.sessions ?? [], servers: {} },
    ciHalf: { ci: over.ci ?? {} },
  };
}

/** The store the fixtures are installed into — only the three halves are written. */
interface WorldStore {
  topology: unknown;
  sessionHalf: unknown;
  ciHalf: unknown;
}

/**
 * Put a fixture world into the store.
 *
 * One place that knows the store's field names, so a rename is one edit rather than one
 * per test file — which is what the previous per-file assignments would have cost.
 */
export function install(store: WorldStore, w: FixtureWorld): FixtureWorld {
  store.topology = w.topology;
  store.sessionHalf = w.sessionHalf;
  store.ciHalf = w.ciHalf;
  return w;
}
