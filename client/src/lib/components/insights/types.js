// The wire shapes of the transcript endpoints, as JSDoc typedefs.
//
// The client checks JS with `strict` (client/jsconfig.json), and these responses are
// nested enough that annotating them inline at each call site would be worse than
// useless. Written against the real payloads from server/transcript-routes.js — if a
// field here is wrong, the mistake is visible at every consumer rather than at one.
//
// Runtime-empty on purpose: this file exists only so `import('./types.js').Foo` works.

/**
 * @typedef {Object} SessionMeta
 * @property {string} id
 * @property {string} [title]
 * @property {string} [feature]
 * @property {string} [branch]
 * @property {string} [repo]
 * @property {boolean} [active]
 * @property {string} [state]     working | waiting | idle | stopped
 */

/**
 * @typedef {Object} Hit
 * @property {string} sessionId
 * @property {string} uuid
 * @property {string} [role]
 * @property {string|null} [model]
 * @property {string|null} [ts]
 * @property {number|null} [tsMs]
 * @property {string|null} [gitBranch]
 * @property {boolean} [sidechain]
 * @property {string} snippet     may carry the FTS5 « » highlight markers
 * @property {SessionMeta} [session]
 */

/**
 * @typedef {Object} SearchResponse
 * @property {boolean} [ok]
 * @property {string} [backend]   sqlite-fts5 | sqlite-like | file-scan
 * @property {string} [query]
 * @property {Hit[]} hits
 * @property {number} [total]     the length of THIS page, not a corpus count
 * @property {SessionMeta} [session]
 */

/**
 * Token counts, shared by every usage payload. Split by cache TTL because a 1h cache
 * write bills at 2x the input rate and a 5m one at 1.25x.
 * @typedef {Object} Tokens
 * @property {number} input
 * @property {number} output
 * @property {number} cacheWrite5m
 * @property {number} cacheWrite1h
 * @property {number} cacheWrite
 * @property {number} cacheRead
 * @property {number} [webSearch]
 * @property {number} [webFetch]
 */

/**
 * @typedef {Tokens & {
 *   model: string|null,
 *   speed: string|null,
 *   messages: number,
 *   costUsd: number|null,
 *   priced: boolean,
 * }} ModelUsage
 */

/**
 * @typedef {Tokens & {
 *   session?: SessionMeta,
 *   source?: string,
 *   reason?: string,
 *   messages?: number,
 *   assistantMessages?: number,
 *   userMessages?: number,
 *   firstAt?: number|null,
 *   lastAt?: number|null,
 *   byModel: ModelUsage[],
 *   costUsd: number|null,
 *   costIsEstimate?: boolean,
 *   unpricedModels: string[],
 *   indexed?: boolean,
 * }} Usage
 */

/**
 * @typedef {Tokens & {
 *   feature: string,
 *   sessions: number,
 *   costUsd: number|null,
 *   unpricedModels: string[],
 * }} FeatureUsage
 */

/** @typedef {Tokens & { costUsd: number|null, unpricedModels: string[] }} Totals */

/**
 * @typedef {{
 *   sessions: Usage[],
 *   features: FeatureUsage[],
 *   totals: Totals,
 *   costIsEstimate: boolean,
 *   pricing?: { verifiedAt: string, note: string },
 *   backend?: string,
 * }} FleetUsage
 */

/**
 * @typedef {Object} TranscriptStatus
 * @property {boolean} ready
 * @property {string} backend
 * @property {boolean} fts5
 * @property {string} [file]
 * @property {string|null} [error]
 * @property {number} sessions
 * @property {number} messages
 * @property {{ verifiedAt: string, note: string }} [pricing]
 */

/**
 * A session as /api/state reports it — note `repoName`, where the transcript
 * endpoints' SessionMeta says `repo` for the same thing.
 * @typedef {Object} StateSession
 * @property {string} id
 * @property {string} [title]
 * @property {string} [feature]
 * @property {string} [branch]
 * @property {string} [repoName]
 * @property {string} [state]
 * @property {boolean} [active]
 */

export {};
