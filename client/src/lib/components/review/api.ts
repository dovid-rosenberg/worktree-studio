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

import { TOKEN } from '$lib/api.js';

/*
 * The diff shapes come from the SERVER, not a second description of them. server/diff.ts
 * produces these and server/types.ts declares them; the copies that used to live here as
 * @typedefs could drift from the producer without anything noticing.
 */
export type { DiffLine, DiffRow, DiffHunk, DiffFile } from '../../../../../server/types';
import type { DiffFile, DiffHunk } from '../../../../../server/types';

/** The client's older names for two server shapes, kept so call sites read unchanged. */
export type Hunk = DiffHunk;
export type ParsedFile = DiffFile;

export interface DetailFile {
  file: string;
  status: string;
  added: number;
  deleted: number;
  diff?: string;
  parsed: ParsedFile | null;
}

export interface Commit {
  sha: string;
  author: string;
  when: string;
  subject: string;
  added: number;
  deleted: number;
  fileCount: number;
}

export interface RepoCommits {
  repo: string;
  worktreePath: string;
  branch: string;
  base: string;
  defaultBranch: string;
  commits: Commit[];
  uncommitted: { fileCount: number; added: number; deleted: number };
}

export interface FileHunks {
  file: string;
  untracked: boolean;
  unstaged: ParsedFile | null;
  staged: ParsedFile | null;
}

const api = (id: string): string => `/api/v1/sessions/${encodeURIComponent(id)}`;

/**
 * The daemon's boot token, from the one module that resolves it.
 *
 * This panel keeps its own request/response plumbing (its routes and its error shape
 * are its own), but NOT its own answer to auth: resolving the token means knowing that
 * the injected value may still be the un-substituted placeholder and that dev gets it
 * from Vite instead. Two copies of that means one of them is wrong — and it was: this
 * file read `globalThis.WTS_TOKEN` with neither guard, so in dev it sent the literal
 * placeholder and every call 401'd.
 */
function authHeaders() {
  return TOKEN ? { 'x-wts-token': TOKEN } : undefined;
}

/**
 * One place that turns a non-2xx into a thrown Error carrying the server's own message.
 * The hunk routes answer 400 with `{ ok:false, error }` for every refusal that is the
 * caller's to fix (stale hunk, binary file, nothing to stage) — that text is written for
 * a human, so it is exactly what the UI should show.
 */
async function unwrap(res: Response): Promise<any> {
  let body = null;
  try { body = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status} ${res.statusText}`);
  return body;
}

/**
 */
export async function fetchCommits(sessionId: string, signal?: AbortSignal): Promise<{ repos: RepoCommits[] }> {
  return unwrap(await fetch(`${api(sessionId)}/commits`, { signal, headers: authHeaders() }));
}

/**
 * `sha` is a real sha, or the literal `'uncommitted'` for the working tree.
 */
export async function fetchCommitDetail(sessionId: string, repo: string, sha: string, signal?: AbortSignal): Promise<{ files: DetailFile[] }> {
  const q = `?repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(sha)}`;
  return unwrap(await fetch(`${api(sessionId)}/commit-detail${q}`, { signal, headers: authHeaders() }));
}

/**
 * Both sides of one working file: `unstaged` can be staged, `staged` can be unstaged.
 */
export async function fetchHunks(sessionId: string, repo: string, file: string, signal?: AbortSignal): Promise<FileHunks> {
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
 */
export async function applyHunks(op: 'stage' | 'unstage', sessionId: string, sel: { repo: string; file: string; hunks: number[]; expect: string[] }): Promise<FileHunks & { ok: true; hunks: number[] }> {
  const res = await fetch(`${api(sessionId)}/hunks/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(sel),
  });
  return unwrap(res);
}
