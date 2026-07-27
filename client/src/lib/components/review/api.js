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
  return unwrap(await fetch(`${api(sessionId)}/commits`, { signal }));
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
  return unwrap(await fetch(`${api(sessionId)}/commit-detail${q}`, { signal }));
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
  return unwrap(await fetch(`${api(sessionId)}/hunks${q}`, { signal }));
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sel),
  });
  return unwrap(res);
}
