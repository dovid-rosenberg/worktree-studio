// The wire contract, derived from the code that builds it.
//
// Four consumers read these shapes and none of them share a process with the
// server: the SvelteKit client, the SwiftBar menubar plugin, the Alfred workflow
// and bin/wt-studio.js. docs/api.md describes the same contract in prose; where
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

/** Where a repo's worktrees live on disk (server/layout.js). */
export interface WorktreeLayout {
  layout: 'nested' | 'sibling' | 'external';
  dir: string;
  root: string;
}

/** What makes two worktrees in different repos "the same feature" (server/identity.js). */
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

/** One repo's dev-server launch config. */
export interface StartConfig {
  cmd?: string;
  ports?: number[];
  [key: string]: unknown;
}

/** An imported editor run/test config. */
export interface RunConfig {
  name: string;
  cmd: string;
  kind?: string;
  source?: string;
}

export interface ConcurrencyConfig {
  enabled: boolean;
  offsetStep: number;
  maxSlots: number;
  /** Ships EMPTY — the port map is one organisation's, not a default. */
  repos: Record<string, unknown>;
}

/**
 * config.json as server/config.js hands it to everything else.
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
  editors: Record<string, { open: string }>;
  defaultEditor: string;
  worktrees: WorktreeLayout;
  featureIdentity: FeatureIdentityConfig;
  copyPatterns: Record<string, string[]>;
  copyAlways: Record<string, string[]>;
  start: Record<string, StartConfig>;
  webRepos: string[];
  groups: GroupConfig[];
  runConfigs: Record<string, RunConfig[]>;
  popout: { terminal: string };
  sources: {
    github?: { enabled: boolean };
    gitlab?: { enabled: boolean; host: string; token: string };
    asana?: { enabled: boolean; token: string; workspace: string };
    [id: string]: unknown;
  };
  notify: { waiting: boolean; sound: boolean; idle: boolean };
  concurrency: ConcurrencyConfig;
  _file?: string;
  _stateDir?: string;
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
  /** The feature identity, resolved by server/identity.js — NOT the worktree name. */
  feature: string;
  repos: SessionRepo[];
  /** Repos chosen up front, added at promote time. */
  pendingRepos: Array<{ repo: string; repoPath: string }>;
  suggestedBranch: string | null;
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
  baseBranch: string | null;
  baseDir: string;
  running: boolean;
  pid: number | null;
  ports: number[];
  canStart: boolean;
  /** Always null on a main checkout — only linked worktrees carry sessions. */
  session: EmbeddedSession | null;
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
  defaultBranch: string | null;
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

/** The chrome a client renders from, alongside the topology it decorates. */
export interface StateConfigSummary {
  port: number;
  configFile: string | undefined;
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

// ---- the diff model (server/diff.js) ----------------------------------------

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

export interface DiffHunk {
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
