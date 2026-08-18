// Thin wrappers over the transcript search endpoints.
//
// Same-origin by construction: in dev Vite proxies /api to the daemon, in production
// the daemon serves this bundle itself. No base URL, no config.
//
// Every call takes an AbortSignal. Search fires on keystroke, so the previous request
// must be cancellable or a slow query can land after a fast one and overwrite it.
//
// Same-origin does NOT mean unauthenticated: every /api route is behind the boot token
// (server/security.ts). Auth, parsing and the non-2xx error shape all come from
// $lib/api.js's `request` — this module used to re-implement all three.

import { request } from '$lib/api.js';
import type { SearchResponse, StateSession, TranscriptStatus } from './types';

const V1 = '/api/v1';

const get = async (url: string, signal?: AbortSignal): Promise<any> =>
  request('GET', url, { signal, strictJson: true });

const post = async (url: string, body: unknown, signal?: AbortSignal): Promise<any> =>
  request('POST', url, { body: body || {}, signal });

const qs = (params: Record<string, string | number | boolean | null | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    s.set(k, String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : '';
};

/** Index health: backend, whether FTS5 is available, and how much is indexed. */
export const transcriptStatus = (signal?: AbortSignal): Promise<TranscriptStatus> =>
  get(`${V1}/transcripts/status`, signal);

/**
 * Search. Always the global endpoint — passing `session` scopes it to one session AND
 * makes the server bring that session's index up to date first, so a scoped search is
 * never stale. The per-session endpoint is equivalent but omits per-hit session meta,
 * which the results list needs in order to render a hit from an unknown session.
 */
export interface SearchOpts {
  q: string;
  session?: string | null;
  role?: string | null;
  order?: string | null;
  limit?: number;
}

export const searchTranscripts = (
  { q, session, role, order, limit = 40 }: SearchOpts,
  signal?: AbortSignal,
): Promise<SearchResponse> =>
  get(`${V1}/transcripts/search${qs({ q, session, role, order, limit })}`, signal);

export const reindex = (
  { session, full }: { session?: string | null; full?: boolean } = {},
  signal?: AbortSignal,
): Promise<any> => post(`${V1}/transcripts/reindex`, { session, full }, signal);

/** The session list, for the search scope picker and session titles. */
export async function listSessions(signal?: AbortSignal): Promise<StateSession[]> {
  const state = await get('/api/v1/state', signal);
  return Array.isArray(state?.sessions) ? state.sessions : [];
}

// ── query handling ───────────────────────────────────────────────────────────
//
// FTS5's MATCH argument is a query language, not a search box: a bare `OR`, an
// unbalanced quote or a stray `*` is a syntax error, and `NEAR`/`-` mean something.
// server/transcript-index.js `ftsQuery()` defuses this by quoting every whitespace-run
// as a literal phrase and ANDing them.
//
// This mirrors that tokenizer, for two reasons the server can't cover: it lets the UI
// SAY what will actually be matched, and it detects the inputs that reduce to nothing
// (`"`, `***` once quoting strips them) so the panel can explain an empty result
// instead of showing a blank list. Kept deliberately identical — if the server's
// tokenizer changes, this must change with it.

/** The literal phrases the server will AND together. */
export function ftsTerms(q: string): string[] {
  const terms = String(q || '').match(/"[^"]*"|\S+/g) || [];
  return terms.map((t) => t.replace(/"/g, ' ').trim()).filter(Boolean);
}

/** Highlight-safe: the same terms, longest first, for client-side marking. */
export function highlightTerms(q: string): string[] {
  return ftsTerms(q).sort((a, b) => b.length - a.length);
}
