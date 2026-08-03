// The wire contract, derived from the code that builds it.
//
// Four consumers read these shapes and none of them share a process with the
// server: the SvelteKit client, the SwiftBar menubar plugin, the Alfred workflow
// and bin/wt-studio.ts. docs/api.md describes the same contract in prose; where
// the two disagree, this file follows the code, because the code is what answers
// the request.
//
// A real module, not a .d.ts, for two reasons: Node 22 strips types natively so a
// `.ts` file costs nothing to require, and a contract that can carry a runtime
// guard later (`isSession(x)`) should not be shut out of doing so by its file
// extension. Nothing here emits anything today.
//
// Erasable syntax only — no enum, no namespace, no parameter properties, no
// decorators. Node's stripper rejects all four, and this file is on the require
// path the moment anything imports a value from it.

'use strict';

// ---- primitives -------------------------------------------------------------

/** A session's lifecycle state, as the Claude Code hooks report it. */
export type SessionState = string;

/** ISO-8601 as Claude Code writes it into a transcript. */
export type IsoTimestamp = string;

// ---- config -----------------------------------------------------------------

/**
 * Every key optional, all the way down, with arrays left alone.
 *
 * This is what a config looks like to a consumer that reads a handful of keys and
 * falls back on each — most of the server, and every test that hand-rolls a cfg.
 * `Partial<Config>` is not enough: it stops at the top level, so a `{ web: { port } }`
 * would still be required to carry `web.host`.
 */
export type PartialDeep<T> =
  T extends (infer _U)[] ? T
    : T extends object ? { [K in keyof T]?: PartialDeep<T[K]> }
      : T;

/** Where a repo's worktrees live on disk (server/layout.ts). */
export interface WorktreeLayout {
  layout: 'nested' | 'sibling' | 'external';
  dir: string;
  root: string;
}

/** What makes two worktrees in different repos "the same feature" (server/identity.ts). */
export interface FeatureIdentityConfig {
  strategy: 'basename' | 'branch' | 'manifest';
  branchPattern: string;
  branchFlags: string;
}

/** A manual feature group: members are `repo/<branch-or-wtname>` refs. */
export interface GroupConfig {
  name: string;
  members: string[];
}

/**
 * One repo's dev-server launch config.
 *
 * The bare-string form is worktree-dash compatibility: `start[repo] = "npm run dev"`.
 * config.ts copies `dash.start` across verbatim, so a config written by worktree-dash
 * arrives in that shape and servers.startCfg() reads it as `{ cmd, ports: [] }`.
 *
 * `cmd` is optional on the object form because a hand-edited config.json can carry a
 * `ports`-only row. That is not launchable, and startCfg() answers null for it —
 * stating it here is what keeps `canStart` from advertising a command that isn't there.
 */
export type StartConfig = string | { cmd?: string; ports?: number[] };

/**
 * How to open a path in one editor.
 *
 * `openGroup` is optional and shipped: server/orchestrator.ts reads it to open a
 * whole feature at once, POST /settings persists it, and docs/api.md documents it.
 * An editor without one falls back to running `open` per member.
 */
export interface EditorConfig {
  /** Shell command with `{path}` substituted. */
  open: string;
  /** Shell command opening several paths at once; `{paths}` is the substitution. */
  openGroup?: string;
}

/** An imported editor run/test config. */
export interface RunConfig {
  name: string;
  cmd: string;
  kind?: string;
  source?: string;
}

/**
 * Re-point a gitignored FE config file at a sibling repo's slot-shifted ports.
 *
 * The FE has no env var for the backend it talks to — the URL is baked into a
 * checked-out file — so the only way to move it is to rewrite the file itself.
 */
export interface ConfigPatch {
  /** Repo-relative path of the file to rewrite. */
  file: string;
  /** The repo whose `portEnv` supplies the port families to shift. */
  siblingRepo: string;
}

/**
 * One repo's concurrency mapping: which env vars carry ports, and which carry
 * the slot index itself.
 */
export interface RepoConcurrency {
  /** ENV_VAR → base port. Slot n sets it to `base + n*offsetStep`. */
  portEnv?: Record<string, number>;
  /** ENV_VARs set to the slot INDEX, not a port (e.g. a Redis DB number). */
  slotEnv?: string[];
  configPatch?: ConfigPatch;
}

export interface ConcurrencyConfig {
  enabled: boolean;
  offsetStep: number;
  maxSlots: number;
  /** Ships EMPTY — the port map is one organisation's, not a default. */
  repos: Record<string, RepoConcurrency>;
}

/**
 * Pacing overrides for server/watch.ts, merged over that module's DEFAULTS.
 *
 * Hand-added to config.json, like `sources.gitlab.project` below: defaults() never
 * ships it, and without it watch.ts's own DEFAULTS are what is in force. It is named
 * here anyway because watch.ts documents it as a supported knob, and a knob a user
 * is invited to set belongs in the config contract rather than only in the module
 * that reads it. Every key is optional — the merge is per-key.
 */
export interface WatchPacing {
  /** scheduler heartbeat */
  tickMs?: number;
  /** how long a burst of fs events must be quiet before a scan */
  debounceMs?: number;
  /** …but a sustained stream still lands within this */
  maxDebounceMs?: number;
  /** hard ceiling on how often watching alone shells out to git */
  minRescanMs?: number;
  /** safety-net rescan, dashboard open */
  netActiveMs?: number;
  /** safety-net rescan, nobody looking */
  netIdleMs?: number;
  /** lsof sweep, dashboard open */
  runningActiveMs?: number;
  /** lsof sweep, nobody looking */
  runningIdleMs?: number;
  /** multiplexer liveness, dashboard open */
  reconcileActiveMs?: number;
  /** multiplexer liveness, nobody looking */
  reconcileIdleMs?: number;
  /** refuse to arm past this many fs watchers */
  maxWatchers?: number;
}

/**
 * config.json as server/config.ts hands it to everything else.
 *
 * `_file` and `_stateDir` are stamped on at load time and are not written back;
 * the leading underscore is the marker that they describe the file rather than
 * living in it.
 */
export interface Config {
  baseDirs: string[];
  scanDepth: number;
  web: { port: number; host: string };
  claude: { cmd: string };
  editors: Record<string, EditorConfig>;
  defaultEditor: string;
  worktrees: WorktreeLayout;
  featureIdentity: FeatureIdentityConfig;
  copyPatterns: Record<string, string[]>;
  copyAlways: Record<string, string[]>;
  start: Record<string, StartConfig>;
  webRepos: string[];
  groups: GroupConfig[];
  runConfigs: Record<string, RunConfig[]>;
  sources: {
    github?: { enabled: boolean };
    // `project` is read by the REST fallback in sources/gitlab.ts and gated on by its
    // isEnabled(), but defaults() never ships it — it is hand-added to config.json,
    // which is why it is the one optional key in this block.
    gitlab?: { enabled: boolean; host: string; token: string; project?: string };
    asana?: { enabled: boolean; token: string; workspace: string };
    [id: string]: unknown;
  };
  notify: { waiting: boolean; sound: boolean; idle: boolean };
  concurrency: ConcurrencyConfig;
  /** Absent from defaults(); see WatchPacing. */
  watch?: WatchPacing;
  _file?: string;
  /**
   * Where the state directory is. REQUIRED, unlike `_file`: load() stamps it
   * unconditionally and every reader (servers.ts, sessions.ts, transcript-routes.ts)
   * joins a path onto it, so an absent one is a `path.join(undefined, …)` throw
   * rather than a degraded mode. `_file` stays optional because save() has an
   * explicit fallback for it and nothing here has one for this.
   */
  _stateDir: string;
  /**
   * The boot token. Never written back to config.json.
   *
   * REQUIRED for the same reason, and one more: security.ts `createGuard` takes a
   * `token: string`, and an undefined one would make the guard fail closed and 401
   * every request — including the hook posts a live session depends on — with no
   * error anywhere. load() always assigns `security.loadToken()`, which always
   * returns a string, so the invariant is stated here rather than re-checked at each
   * use. Hand-built configs are typed `PartialDeep<Config>`, which is unaffected.
   */
  _token: string;
}

// ---- sessions ---------------------------------------------------------------

/** One repo a session spans. Worktree fields stay null until promote(). */
export interface SessionRepo {
  repo: string;
  repoPath: string;
  worktree: string | null;
  worktreePath: string | null;
  branch: string | null;
  primary?: boolean;
}

/** A multiplexer window. */
export interface SessionTab {
  /**
   * The multiplexer's window id. Tabs are addressed by THIS, never by array position:
   * tmux runs with `renumber-windows on`, so closing one window shifts every later
   * index, and a position recorded before the close names a different window after it.
   */
  id: string;
  title: string;
}

/**
 * A session, as SessionManager stores it and `sessionState().sessions` emits it.
 * This is the FULL record — the copy embedded in a worktree row or a feature is
 * `EmbeddedSession` below, which is four fields and nothing else.
 */
export interface Session {
  id: string;
  title: string;
  source: string;
  sourceId: string | null;
  sourceUrl: string | null;
  repoName: string;
  repoPath: string;
  /** Where claude runs, so `--resume` finds the transcript. Moves on promote(). */
  home: string;
  worktree: string | null;
  worktreePath: string | null;
  branch: string | null;
  /** The feature identity, resolved by server/identity.ts — NOT the worktree name. */
  feature: string;
  repos: SessionRepo[];
  /** Repos chosen up front, added at promote time. */
  pendingRepos: Array<{ repo: string; repoPath: string }>;
  suggestedBranch: string | null;
  /** Never null: a slug of the title is the floor. */
  suggestedName: string;
  muxName: string;
  claudeSessionId: string | null;
  state: SessionState;
  activity: string;
  tabs: SessionTab[];
  /** Single-line seed, delivered as claude's launch arg. */
  seed: string | null;
  active: boolean;
  createdAt: number;
  promotedAt: number | null;
  /** Present only on sessions opened over a worktree that already existed. */
  adopted?: boolean;
  /** The generated `--settings` file claude was launched with. */
  settingsFile?: string;
  /**
   * The session's hook settings were written WITH a token, so its hook posts are
   * authenticated. Sessions launched before the token existed lack it and are
   * grandfathered in by the hook route.
   */
  hookAuth?: boolean;
  /** Epoch ms of the last hook event. Absent until the first one arrives. */
  lastEventAt?: number;
}

/**
 * The trimmed session copy `topology()` embeds in every worktree row and feature.
 *
 * It is a SNAPSHOT taken when the topology frame was built, and topology moves far
 * more slowly than session state — so these copies age between frames. A client
 * re-projects the live `sessions[]` onto them rather than rendering them directly.
 */
export interface EmbeddedSession {
  id: string;
  state: SessionState;
  activity: string;
  muxName: string;
}

// ---- topology ---------------------------------------------------------------

/**
 * A worktree row: the git facts, the dev-server discovery, and the driving session.
 * The same object appears in `repos[].worktrees[]` and, by reference, in
 * `features[].members[]` / `groups[].members[]`.
 */
export interface Worktree {
  repo: string;
  wtname: string;
  branch: string | null;
  path: string;
  /** True for the repo's main checkout. Main checkouts are never features. */
  isMain: boolean;
  detached: boolean;
  merged: boolean;
  /** The owning repo's defaultBranch, repeated. Never null — git.ts falls back to 'main'. */
  baseBranch: string;
  /** The scanned baseDir this repo sits under, or '' when none matched. */
  baseDir: string;
  running: boolean;
  pid: number | null;
  ports: number[];
  canStart: boolean;
  /** Always null on a main checkout — only linked worktrees carry sessions. */
  session: EmbeddedSession | null;
  /** Never set. Present so `member.missing` discriminates FeatureMember. */
  missing?: false;
  /** package.json present, node_modules absent — the start command cannot succeed. */
  depsMissing?: boolean;
  /** An install is running for this worktree right now. */
  depsInstalling?: boolean;
  /** No `config.start` entry for this repo — the other reason `canStart` is false. */
  noStartCmd?: boolean;
}

/**
 * A repo and its worktrees.
 *
 * `name` and `repo` are the same string. Both are emitted because the two client
 * generations key on different ones; neither is derived from the other at read time.
 */
export interface Repo {
  name: string;
  repo: string;
  path: string;
  /** origin/HEAD's branch, else the current branch, else 'main' — never null. */
  defaultBranch: string;
  /** Main checkout first: `git worktree list` lists it first and isMain is index 0. */
  worktrees: Worktree[];
}

/** A manual group member naming a worktree that is not on disk right now. */
export interface MissingMember {
  missing: true;
  ref: string;
}

export type FeatureMember = Worktree | MissingMember;

/**
 * A feature (or group) — a named unit owning one or more worktrees across repos.
 *
 * `features` is every unique linked-worktree identity, singles included; `groups`
 * is the same list filtered to those with 2+ members, plus every manual group.
 * A manual group appears in both.
 */
export interface Feature {
  name: string;
  /** false for a manual group from config.groups, true for a derived one. */
  auto: boolean;
  members: FeatureMember[];
  /** The single driving session — the first member that has one. */
  session: EmbeddedSession | null;
  /** The concurrency slot (0,1,2…), present only while one is allocated. */
  slot?: number;
}

/**
 * A feature as `resolveGroup()` answers it: members naming a worktree that is not
 * on disk have been dropped, so every remaining member is a real worktree row.
 */
export interface ResolvedFeature extends Omit<Feature, 'members'> {
  members: Worktree[];
}

/**
 * The two config values the payload carries. NOT the config file — that is
 * `GET /settings`. `configFile` is the absolute path of the file that was loaded.
 */
export interface StateConfigSummary {
  port: number;
  configFile: string;
}

/** One intake source, as server/sources reports the enabled ones. */
export interface SourceInfo {
  id: string;
  label: string;
  needsRepo: boolean;
}

/** The `topology` half: the slow-moving shape, rebuilt only when it changes. */
export interface TopologyPayload {
  /** The multiplexer's name, or 'none' when none is wired. */
  mux: string;
  config: StateConfigSummary;
  runningTotal: number;
  baseDirs: string[];
  /** Editor NAMES (the keys of config.editors), not the editor configs. */
  editors: string[];
  defaultEditor: string;
  webRepos: string[];
  runConfigs: Record<string, RunConfig[]>;
  sources: SourceInfo[];
  repos: Repo[];
  features: Feature[];
  groups: Feature[];
}

// ---- session state ----------------------------------------------------------

/** One repo's dev-server state within a session's shared workspace. */
export interface SessionServerRepo {
  repo: string;
  worktreePath: string;
  running: boolean;
  ports: number[];
  canStart: boolean;
}

/**
 * Dev-server state per session, keyed by session id.
 *
 * A session with no worktree anywhere is ABSENT from this map rather than present
 * with an empty list — so a lookup must tolerate a miss.
 */
export type SessionServers = Record<string, { repos: SessionServerRepo[] }>;

/** The `session-state` half: what a Claude Code hook touches, on every tool call. */
export interface SessionStatePayload {
  sessions: Session[];
  servers: SessionServers;
}

// ---- CI ---------------------------------------------------------------------

export interface CiChecks {
  passed: number;
  running: number;
  failed: number;
  total: number;
}

/** One repo's PR/MR + checks. Every failure mode degrades to `hasPR: false`. */
export interface CiRepo {
  repo: string;
  hasPR: boolean;
  provider?: string;
  number?: number;
  url?: string;
  state?: string;
  checks?: CiChecks;
}

/**
 * CI keyed by session id. A session with no promoted repo has no entry at all —
 * the sweep skips it rather than writing an empty array.
 */
export type CiSnapshot = Record<string, CiRepo[]>;

/** The `ci` half. Note the extra nesting: the payload wraps the map in `ci`. */
export interface CiPayload {
  ci: CiSnapshot;
}

// ---- the assembled payload --------------------------------------------------

/**
 * `GET /api/state` (and `/api/v1/state`): both halves merged.
 *
 * The SSE stream sends the same data as three named events that a client merges
 * with `state = { ...state, ...frame }`, so the union below is exactly what a
 * converged client holds. Every frame is a FULL REPLACEMENT of its half.
 */
export interface StatePayload extends TopologyPayload, SessionStatePayload {
  /** Present once a `ci` frame has arrived; absent from a cold GET /state. */
  ci?: CiSnapshot;
}

/** The three SSE event names, and the payload each carries. */
export interface SseEvents {
  topology: TopologyPayload;
  'session-state': SessionStatePayload;
  ci: CiPayload;
}

export type SseEventName = keyof SseEvents;

// ---- the diff model (server/diff.ts) ----------------------------------------

export type DiffLineType = 'context' | 'add' | 'del';

/**
 * One line of a hunk. `text` has had its +/-/space marker stripped; a CRLF file's
 * \r is still inside it, because dropping it would corrupt the patch.
 */
export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** null on an addition. */
  oldLine: number | null;
  /** null on a deletion. */
  newLine: number | null;
  /** The line was followed by "\ No newline at end of file". */
  noNewline?: boolean;
  /** That marker's original text — the message is translatable, so it is kept verbatim. */
  noNewlineText?: string;
  /** An empty context line emitted without its leading space; kept so a round trip is byte-exact. */
  bare?: boolean;
}

export type DiffRowType = 'context' | 'add' | 'del' | 'change';

/**
 * One side-by-side row. `left`/`right` are INDEXES into the hunk's `lines`, not
 * copies — so a client renders unified by walking `lines` and side-by-side by
 * walking `rows`, with the text stored once.
 */
export interface DiffRow {
  type: DiffRowType;
  left: number | null;
  right: number | null;
}

/**
 * A hunk's `@@` line, parsed. Separate from DiffHunk because the counts here are
 * what tell the body parser how many lines to consume — the body cannot exist yet.
 */
export interface DiffHunkHeader {
  /** Position in the file's `hunks` — this is the index hunk staging selects on. */
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The trailing text of the `@@` header (git's function-context guess). */
  section: string;
  /** The `@@` header verbatim — the token a stale-selection guard compares on. */
  header: string;
}

export interface DiffHunk extends DiffHunkHeader {
  lines: DiffLine[];
  rows: DiffRow[];
  added: number;
  deleted: number;
}

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied';

/**
 * One `diff --git` block.
 *
 * `header` holds the raw header lines verbatim, which is what lets
 * formatFilePatch() reproduce the input patch byte for byte when every hunk is
 * selected. That round-trip property is the safety net for hunk staging.
 */
export interface DiffFile {
  /** newPath, falling back to oldPath — the path to show. */
  path: string | null;
  /** null when the file is new (`/dev/null` on the old side). */
  oldPath: string | null;
  /** null when the file was deleted. */
  newPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  oldMode: string | null;
  newMode: string | null;
  /** Percentage from `similarity index`, on a rename or copy. */
  similarity: number | null;
  header: string[];
  hunks: DiffHunk[];
  added: number;
  deleted: number;
  /** A chmod with no content change: no hunks, but the header carries the transition. */
  modeOnly?: boolean;
  /** 'combined' — a merge (`@@@`) diff, which can be neither aligned nor re-serialized. */
  unsupported?: 'combined';
}

// ---- transcripts and usage --------------------------------------------------

/**
 * message.usage, flattened to what the price table understands.
 *
 * The per-TTL cache split is load-bearing: a 1h cache write costs 2x the base
 * input rate and a 5m write 1.25x, so pricing the lump as 5m understates any
 * session using the 1h cache.
 */
export interface Usage {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** The lump `cache_creation_input_tokens` — equals the two above. */
  cacheWrite: number;
  cacheRead: number;
  webSearch: number;
  webFetch: number;
  speed: string | null;
}

/** A normalized transcript line. Only `assistant` and `user` records become entries. */
export interface TranscriptEntry {
  kind: 'assistant' | 'user';
  role: string;
  uuid: string | null;
  parentUuid: string | null;
  /** The API message id — the dedup key for usage, see UsageTotals. */
  msgId: string | null;
  requestId: string | null;
  ts: IsoTimestamp | null;
  tsMs: number | null;
  model: string | null;
  speed: string | null;
  cwd: string | null;
  gitBranch: string | null;
  sidechain: boolean;
  /** Capped; a truncated body ends in an ellipsis. */
  text: string;
  /** null on every user entry. */
  usage: Usage | null;
}

/** Per-model tokens and cost. A session routinely spans models, and cost is
 *  meaningless without knowing which rate applied. */
export interface UsageByModel {
  model: string;
  speed: string | null;
  messages: number;
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWrite: number;
  cacheRead: number;
  webSearch: number;
  webFetch: number;
  /** null when the model is not in the price table. */
  costUsd: number | null;
  priced: boolean;
}

/**
 * aggregate() over one transcript.
 *
 * Usage is deduplicated on `msgId` before it is summed: Claude Code writes one
 * JSONL line per CONTENT BLOCK and repeats the identical usage on each, so summing
 * lines over-counts by ~2.9x on a tool-heavy session.
 */
export interface UsageTotals {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWrite: number;
  cacheRead: number;
  webSearch: number;
  webFetch: number;
  assistantMessages: number;
  userMessages: number;
  firstAt: number | null;
  lastAt: number | null;
  byModel: UsageByModel[];
  costUsd: number | null;
  /** Always true: transcripts record tokens, not billing. */
  costIsEstimate: true;
  /** Billable models missing from the price table — `complete` is false when non-empty. */
  unpricedModels: string[];
  complete: boolean;
  file: string;
  bytes: number;
  offset: number;
  malformedLines: number;
  truncatedTail: boolean;
}

// ---- intake sources (server/sources/*) --------------------------------------

/** One candidate in the picker, as `list()` hands it back. */
export interface SourceItem {
  id: string;
  title: string;
  subtitle: string;
}

/** The upstream record a session is opened from, as `seed()` hands it back. */
export interface SourceSeed {
  /** The adapter's own `id`. */
  source: string;
  /** null for free text, which has no upstream record to point at. */
  id: string | null;
  title: string;
  body: string;
  /** null when the record has no page of its own. */
  url: string | null;
}

/**
 * The bag `list()` and `seed()` are handed — the union of what the adapters read,
 * every key optional because the route passes one flat object to all of them and a
 * key another adapter needs is simply absent.
 *
 * `q` is `unknown` rather than a string because it arrives as `req.query.q`, which
 * express parses to an ARRAY for `?q=a&q=b` and to an object for `?q[x]=y`. An
 * adapter has to coerce it before it reaches an execFile argv or a URL.
 */
export interface SourceParams {
  repoPath?: string;
  q?: unknown;
  id?: string;
  text?: string;
  name?: string;
}

/**
 * One intake source adapter, as server/sources/index.ts drives it: the picker calls
 * `isEnabled` then `list`, and opening a session calls `seed`.
 *
 * The adapters are independent modules whose only tie to each other is this shape,
 * so it lives here rather than in whichever one was written first.
 */
export interface SourceAdapter extends SourceInfo {
  isEnabled(cfg: PartialDeep<Config>): boolean;
  list(cfg: PartialDeep<Config>, params: SourceParams): Promise<SourceItem[]>;
  seed(cfg: PartialDeep<Config>, params: SourceParams): Promise<SourceSeed>;
}
