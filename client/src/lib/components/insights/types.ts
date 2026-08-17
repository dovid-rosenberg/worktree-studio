// The wire shapes of the transcript endpoints.
//
// These responses are nested enough that annotating them inline at each call site
// would be worse than useless. Written against the real payloads from
// server/transcript-routes.ts — if a field here is wrong, the mistake is visible at
// every consumer rather than at one.
//
// Runtime-empty on purpose: types only, erased at build.

export interface SessionMeta {
  id: string;
  title?: string;
  feature?: string;
  branch?: string;
  repo?: string;
  active?: boolean;
  /** working | waiting | idle | stopped */
  state?: string;
}

export interface Hit {
  sessionId: string;
  uuid: string;
  role?: string;
  model?: string | null;
  ts?: string | null;
  tsMs?: number | null;
  gitBranch?: string | null;
  sidechain?: boolean;
  /** may carry the FTS5 « » highlight markers */
  snippet: string;
  session?: SessionMeta;
}

export interface SearchResponse {
  ok?: boolean;
  /** sqlite-fts5 | sqlite-like | file-scan */
  backend?: string;
  query?: string;
  hits: Hit[];
  /** the length of THIS page, not a corpus count */
  total?: number;
  session?: SessionMeta;
}

export interface TranscriptStatus {
  ready: boolean;
  backend: string;
  fts5: boolean;
  file?: string;
  error?: string | null;
  sessions: number;
  messages: number;
}

export interface StateSession {
  id: string;
  title?: string;
  feature?: string;
  branch?: string;
  repoName?: string;
  state?: string;
  active?: boolean;
}
