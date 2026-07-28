/*
 * The review panel's slice of the daemon API. Everything the Changes panel needs and
 * nothing else, so the panel never reaches for a global fetch helper the shell owns.
 *
 * Routes (server/server.js + server/routes-review.js), all under /api/v1:
 *   GET  /sessions/:id/commits                     branch commits + uncommitted summary
 *   GET  /sessions/:id/commit-detail?repo=&sha=    per-file diffs (+ `parsed` model)
 *   GET  /sessions/:id/hunks?repo=&file=           stageable / unstageable hunks
 *   POST /sessions/:id/hunks/stage | /unstage      { repo, file, hunks, expect }
 */

/**
 * @typedef {{ type:'context'|'add'|'del', text:string, oldLine:number|null, newLine:number|null,
 *             noNewline?:boolean, bare?:boolean }} DiffLine
 * @typedef {{ type:'context'|'add'|'del'|'change', left:number|null, right:number|null }} DiffRow
 * @typedef {{ index:number, oldStart:number, oldLines:number, newStart:number, newLines:number,
 *             section:string, header:string, lines:DiffLine[], rows:DiffRow[],
 *             added:number, deleted:number }} Hunk
 * @typedef {{ path:string|null, oldPath:string|null, newPath:string|null, status:string,
 *             binary:boolean, oldMode:string|null, newMode:string|null, similarity:number|null,
 *             modeOnly?:boolean, unsupported?:string, header:string[], hunks:Hunk[],
 *             added:number, deleted:number }} ParsedFile
 * @typedef {{ file:string, status:string, added:number, deleted:number, diff?:string,
 *             parsed:ParsedFile|null }} DetailFile
 * @typedef {{ sha:string, author:string, when:string, subject:string,
 *             added:number, deleted:number, fileCount:number }} Commit
 * @typedef {{ repo:string, worktreePath:string, branch:string, base:string, defaultBranch:string,
 *             commits:Commit[], uncommitted:{ fileCount:number, added:number, deleted:number } }} RepoCommits
 * @typedef {{ file:string, untracked:boolean, unstaged:ParsedFile|null, staged:ParsedFile|null }} FileHunks
 */

const api = (/** @type {string} */ id) => `/api/v1/sessions/${encodeURIComponent(id)}`;

/**
 * The daemon's boot token, when there is one.
 *
 * `feat/security-hardening` puts an Origin/Host allowlist and a boot token in front of
 * every `/api` route, and the token reaches the browser as `window.WTS_TOKEN`,
 * substituted into the served HTML by the daemon (see `public/app.js` on that branch —
 * same convention, deliberately, rather than a second one invented here).
 *
 * That work is NOT on this branch, so today this reads undefined and sends nothing,
 * which is exactly right against a daemon with no auth. It is here so the panel does not
 * start 401-ing the day the two merge. Read per request, not captured at module load,
 * because the shell may set it after this module is evaluated.
 */
function authHeaders() {
  const token = /** @type {any} */ (globalThis).WTS_TOKEN;
  return typeof token === 'string' && token ? { 'x-wts-token': token } : undefined;
}

/**
 * One place that turns a non-2xx into a thrown Error carrying the server's own message.
 * The hunk routes answer 400 with `{ ok:false, error }` for every refusal that is the
 * caller's to fix (stale hunk, binary file, nothing to stage) — that text is written for
 * a human, so it is exactly what the UI should show.
 * @param {Response} res
 */
async function unwrap(res) {
  /** @type {any} */
  let body = null;
  try { body = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status} ${res.statusText}`);
  return body;
}

/**
 * @param {string} sessionId
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ repos: RepoCommits[] }>}
 */
export async function fetchCommits(sessionId, signal) {
  return unwrap(await fetch(`${api(sessionId)}/commits`, { signal, headers: authHeaders() }));
}

/**
 * `sha` is a real sha, or the literal `'uncommitted'` for the working tree.
 * @param {string} sessionId
 * @param {string} repo
 * @param {string} sha
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ files: DetailFile[] }>}
 */
export async function fetchCommitDetail(sessionId, repo, sha, signal) {
  const q = `?repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(sha)}`;
  return unwrap(await fetch(`${api(sessionId)}/commit-detail${q}`, { signal, headers: authHeaders() }));
}

/**
 * Both sides of one working file: `unstaged` can be staged, `staged` can be unstaged.
 * @param {string} sessionId
 * @param {string} repo
 * @param {string} file
 * @param {AbortSignal} [signal]
 * @returns {Promise<FileHunks>}
 */
export async function fetchHunks(sessionId, repo, file, signal) {
  const q = `?repo=${encodeURIComponent(repo)}&file=${encodeURIComponent(file)}`;
  return unwrap(await fetch(`${api(sessionId)}/hunks${q}`, { signal, headers: authHeaders() }));
}

/**
 * Stage or unstage hunks by index into the matching side of the last fetchHunks payload.
 *
 * `expect` is the `@@` header of each selected hunk. The server re-reads the diff before
 * applying, so without the guard a file that moved under us would silently stage the
 * WRONG hunk; with it the call is refused and we reload. Always send it.
 *
 * The response is a fresh FileHunks for the file, so the caller can swap its state in
 * place rather than refetching.
 *
 * @param {'stage'|'unstage'} op
 * @param {string} sessionId
 * @param {{ repo:string, file:string, hunks:number[], expect:string[] }} sel
 * @returns {Promise<FileHunks & { ok:true, hunks:number[] }>}
 */
export async function applyHunks(op, sessionId, sel) {
  const res = await fetch(`${api(sessionId)}/hunks/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(sel),
  });
  return unwrap(res);
}
