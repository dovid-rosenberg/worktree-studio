// Thin wrappers over the transcript search + telemetry endpoints.
//
// Same-origin by construction: in dev Vite proxies /api to the daemon, in production
// the daemon serves this bundle itself. No base URL, no config.
//
// Every call takes an AbortSignal. Search fires on keystroke, so the previous request
// must be cancellable or a slow query can land after a fast one and overwrite it.
//
// Same-origin does NOT mean unauthenticated: every /api route is behind the boot token
// (server/security.js). The token comes from $lib/api.js — the one module that knows it
// may still be an un-substituted placeholder and that dev gets it from Vite — rather
// than being resolved a second time here.

import { TOKEN } from '$lib/api.js';
import { adoptPricing } from './pricing.svelte.js';
import type { FleetUsage, SearchResponse, StateSession, TranscriptStatus, Usage } from './types';

const V1 = '/api/v1';

// Every cost-bearing response carries a `pricing` block, and that block is where the
// cache-billing multipliers come from (pricing.svelte.js explains why the client must
// not keep its own copy). Adopting it HERE rather than at each call site means a new
// endpoint cannot forget to — there is no call site to remember it at.
// Generic pass-through: every endpoint answers a different shape, and this only ever
// reads `.pricing` off it. Returning T rather than any keeps each caller's declared
// return type intact instead of laundering it back to any on the way out.
function adopt<T>(json: T): T {
  const p = (json as { pricing?: unknown } | null)?.pricing;
  if (p) adoptPricing(p as Parameters<typeof adoptPricing>[0]);
  return json;
}

const headers = (extra: Record<string, string>): Record<string, string> => (TOKEN ? { ...extra, 'x-wts-token': TOKEN } : extra);

async function get(url: string, signal?: AbortSignal): Promise<any> {
  let res;
  try {
    res = await fetch(url, { signal, headers: headers({ accept: 'application/json' }) });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    // The daemon being down is the common case here, and `TypeError: Failed to fetch`
    // is not something to put in front of a user.
    throw new Error('Cannot reach the Worktree Studio daemon.');
  }
  const body = await res.text();
  let json = null;
  try { json = body ? JSON.parse(body) : null; } catch { /* handled below */ }
  if (!res.ok) throw new Error(json?.error || `${res.status} ${res.statusText}`);
  // A 200 that isn't JSON means something other than the daemon answered — the SPA
  // fallback serving index.html for a mistyped path is the way this actually happens.
  if (json === null) throw new Error('The daemon returned a non-JSON response.');
  return adopt(json);
}

async function post(url: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: headers({ 'content-type': 'application/json', accept: 'application/json' }),
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!res.ok) throw new Error(json?.error || `${res.status} ${res.statusText}`);
  return adopt(json);
}

const qs = (params: Record<string, string | number | boolean | null | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    s.set(k, String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : '';
};

/** Index health: backend, whether FTS5 is available, how much is indexed, price age. */
export const transcriptStatus = (signal?: AbortSignal): Promise<TranscriptStatus> => get(`${V1}/transcripts/status`, signal);

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

/** One session's tokens + cost. */
export const sessionUsage = (id: string, signal?: AbortSignal): Promise<Usage> =>
  get(`${V1}/sessions/${encodeURIComponent(id)}/transcript/usage`, signal);

/** Everything: per session, rolled up per feature, plus a grand total. */
export const fleetUsage = (
  { refresh }: { refresh?: boolean } = {},
  signal?: AbortSignal,
): Promise<FleetUsage> =>
  get(`${V1}/transcripts/usage${qs({ refresh: refresh ? 1 : null })}`, signal);

export const reindex = (
  { session, full }: { session?: string | null; full?: boolean } = {},
  signal?: AbortSignal,
): Promise<any> =>
  post(`${V1}/transcripts/reindex`, { session, full }, signal);

/** The session list, for the search scope picker and session titles. */
export async function listSessions(signal?: AbortSignal): Promise<StateSession[]> {
  const state = await get('/api/state', signal);
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
