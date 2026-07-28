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

const V1 = '/api/v1';

/** @param {Record<string,string>} extra */
const headers = (extra) => (TOKEN ? { ...extra, 'x-wts-token': TOKEN } : extra);

/** @param {string} url @param {AbortSignal} [signal] @returns {Promise<any>} */
async function get(url, signal) {
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
  return json;
}

/** @param {string} url @param {any} body @param {AbortSignal} [signal] @returns {Promise<any>} */
async function post(url, body, signal) {
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
  return json;
}

/** @param {Record<string, string|number|null|undefined>} params */
const qs = (params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    s.set(k, String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : '';
};

/** Index health: backend, whether FTS5 is available, how much is indexed, price age.
 * @param {AbortSignal} [signal] @returns {Promise<import('./types.js').TranscriptStatus>} */
export const transcriptStatus = (signal) => get(`${V1}/transcripts/status`, signal);

/**
 * Search. Always the global endpoint — passing `session` scopes it to one session AND
 * makes the server bring that session's index up to date first, so a scoped search is
 * never stale. The per-session endpoint is equivalent but omits per-hit session meta,
 * which the results list needs in order to render a hit from an unknown session.
 * @param {{ q: string, session?: string|null, role?: string|null, order?: string|null, limit?: number }} opts
 * @param {AbortSignal} [signal]
 * @returns {Promise<import('./types.js').SearchResponse>}
 */
export const searchTranscripts = ({ q, session, role, order, limit = 40 }, signal) =>
  get(`${V1}/transcripts/search${qs({ q, session, role, order, limit })}`, signal);

/** One session's tokens + cost.
 * @param {string} id @param {AbortSignal} [signal]
 * @returns {Promise<import('./types.js').Usage>} */
export const sessionUsage = (id, signal) =>
  get(`${V1}/sessions/${encodeURIComponent(id)}/transcript/usage`, signal);

/** Where a session's transcript is, or why it can't be found.
 * @param {string} id @param {AbortSignal} [signal] */
export const transcriptLocation = (id, signal) =>
  get(`${V1}/sessions/${encodeURIComponent(id)}/transcript`, signal);

/** Everything: per session, rolled up per feature, plus a grand total.
 * @param {{ refresh?: boolean }} [opts] @param {AbortSignal} [signal]
 * @returns {Promise<import('./types.js').FleetUsage>} */
export const fleetUsage = ({ refresh } = {}, signal) =>
  get(`${V1}/transcripts/usage${qs({ refresh: refresh ? 1 : null })}`, signal);

/** @param {{ session?: string|null, full?: boolean }} [opts] @param {AbortSignal} [signal] */
export const reindex = ({ session, full } = {}, signal) =>
  post(`${V1}/transcripts/reindex`, { session, full }, signal);

/** The session list, for the search scope picker and session titles.
 * @param {AbortSignal} [signal] @returns {Promise<import('./types.js').StateSession[]>} */
export async function listSessions(signal) {
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

/** @param {string} q @returns {string[]} the literal phrases the server will AND together. */
export function ftsTerms(q) {
  const terms = String(q || '').match(/"[^"]*"|\S+/g) || [];
  return terms.map((t) => t.replace(/"/g, ' ').trim()).filter(Boolean);
}

/** Highlight-safe: the same terms, longest first, for client-side marking.
 * @param {string} q @returns {string[]} */
export function highlightTerms(q) {
  return ftsTerms(q).sort((a, b) => b.length - a.length);
}
