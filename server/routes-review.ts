// Routes for the structured diff model and hunk-level staging. Self-contained on
// purpose: server.ts wires this in with a single `register(api, deps)` call, so the
// route table can grow here without touching it again.
//
// `api` is the ONE router server.ts mounts at both /api (what the current client
// calls) and /api/v1 (the versioned path new clients should use). Registering onto it
// is what makes every route below answer identically under both prefixes — the module
// never spells a prefix, so it cannot register a route under one and miss the other.
import type { Request, Response, Router } from 'express';
import * as review from './review.ts';
import * as hunks from './hunks.ts';

// The injected collaborators are typed by the surface these routes touch, not by the
// classes server.ts happens to hand over: `manager` is one lookup and a session is two
// fields. That keeps the module testable with a hand-rolled fake — which is how
// test/routes-review.test.js drives it — and it is also the only option while
// server/sessions.ts is still untyped.

/** A session's repo, as far as these routes are concerned. */
interface ReviewRepo {
  repo: string;
  worktreePath?: string | null;
}

/** A repo that has been promoted. `resolveWorktree` never hands back an unpromoted one. */
type PromotedRepo = ReviewRepo & { worktreePath: string };

interface ReviewSession {
  repos?: ReviewRepo[] | null;
}

/** One scan-cache row: the repo name these routes look up, and the branch it answers with. */
interface ScanRepo {
  name: string;
  defaultBranch: string;
}

interface ReviewDeps {
  manager: { get(id: string): ReviewSession | null | undefined };
  repos?: ScanRepo[] | (() => ScanRepo[]);
  broadcast?: () => void;
}

/** The `{ entry } or { status, error }` below, as a shape a handler can bail out of. */
type Resolution =
  | { entry: PromotedRepo; session: ReviewSession; status?: undefined; error?: undefined }
  | { status: number; error: string; entry?: undefined; session?: undefined };

// Resolve :id + ?repo (or body.repo) to the worktree the operation runs in. Returns
// { entry } or { status, error } so each handler bails the same way.
function resolveWorktree(deps: ReviewDeps, req: { params: { id: string } }, repoName: unknown): Resolution {
  const session = deps.manager.get(req.params.id);
  if (!session) return { status: 404, error: 'no such session' };
  const list = (session.repos || []).filter((r): r is PromotedRepo => !!r.worktreePath);
  // With one repo the name is redundant — don't make callers pass it.
  const entry = repoName ? list.find((r) => r.repo === repoName) : list.length === 1 ? list[0] : null;
  if (!entry) return { status: 400, error: repoName ? `unknown repo '${repoName}'` : 'repo is required' };
  return { entry, session };
}

/** One hunk index off the wire: JSON sends a number, a form-encoded body sends a
 *  string. Neither is trusted — hunks.apply() re-checks every index against the diff. */
type HunkIndex = number | string;

/** The body the two staging POSTs read. `repo` is `unknown` because a JSON body can
 *  carry anything there and resolveWorktree only ever compares it. */
interface ApplyBody {
  repo?: unknown;
  file?: string;
  expect?: string | string[];
  hunks?: HunkIndex | HunkIndex[];
  hunk?: HunkIndex;
}

// The hunk indexes a request is acting on: `hunks: [0,2]` or the `hunk: 0` shorthand.
function selection(body: { hunks?: HunkIndex | HunkIndex[]; hunk?: HunkIndex }): HunkIndex[] {
  if (Array.isArray(body.hunks)) return body.hunks;
  if (body.hunks != null) return [body.hunks];
  if (body.hunk != null) return [body.hunk];
  return [];
}

// register(api, deps) — deps: { manager, repos, broadcast? }. `repos` may be the scan
// cache array or a getter for it; server.ts rebuilds that array on every rescan, so it
// passes a getter and this module never holds a stale reference.
function register(api: Router, deps: ReviewDeps): void {
  const { repos } = deps || {};
  if (!deps?.manager) throw new Error('routes-review: deps.manager is required');
  const broadcast = deps.broadcast || (() => {});
  const defaultBranchOf = (name: string): string => {
    const list = typeof repos === 'function' ? repos() : repos || [];
    const hit = list.find((r) => r.name === name);
    // A repo the scan cache has not seen (outside every baseDir, or a rescan that has
    // not landed) has no default branch to report; 'main' is the floor git.ts falls
    // back to for exactly the same reason.
    return (hit?.defaultBranch) || 'main';
  };

  // The structured per-file diff for one commit, or for the working tree when
  // sha=uncommitted (the default). Each file carries the raw patch AND the parsed
  // model — hunks, aligned rows, line numbers on both sides.
  api.get('/sessions/:id/diff', async (req, res) => {
    const r = resolveWorktree(deps, req, req.query.repo);
    if (!r.entry) return res.status(r.status).json({ error: r.error });
    // `?sha=a&sha=b` parses to an ARRAY, and an array reaching isValidSha/execFile is
    // a TypeError — a 500 leaking an internal message where a 400 belongs. Coerce
    // first, exactly like `?file=` below.
    const sha = String(req.query.sha ?? '') || 'uncommitted';
    // Reject at the boundary, so a `sha` that is really a git option never reaches
    // an argv (see review.ts). A bad request is a 400, not a 500.
    if (!review.isValidSha(sha)) return res.status(400).json({ error: 'sha must be a hex object name or "uncommitted"' });
    const detail = await review.commitDetail(r.entry.worktreePath, defaultBranchOf(r.entry.repo), sha);
    res.json({ repo: r.entry.repo, worktreePath: r.entry.worktreePath, sha, files: detail.files });
  });

  // Both sides of one working file, split the way staging needs them: `unstaged` hunks
  // can be staged, `staged` hunks can be unstaged. Hunk indexes in the two POSTs below
  // refer to the matching side of THIS payload.
  api.get('/sessions/:id/hunks', async (req, res) => {
    const r = resolveWorktree(deps, req, req.query.repo);
    if (!r.entry) return res.status(r.status).json({ error: r.error });
    if (!req.query.file) return res.status(400).json({ error: 'file is required' });
    res.json(await hunks.fileHunks(r.entry.worktreePath, String(req.query.file)));
  });

  // Stage / unstage individual hunks. This sits alongside file-level staging (the
  // `paths` argument of POST /sessions/:id/commit) rather than replacing it — some
  // changes (binary, mode-only) can only be staged whole, and that is what the error
  // from these routes says.
  const applyRoute = (op: 'stage' | 'unstage') => async (req: Request<{ id: string }>, res: Response) => {
    const body: ApplyBody = req.body || {};
    const r = resolveWorktree(deps, req, body.repo);
    if (!r.entry) return res.status(r.status).json({ error: r.error });
    const out = await hunks[op](r.entry.worktreePath, {
      file: body.file, hunks: selection(body), expect: body.expect,
    });
    // 400, not 500: a refusal here means the request no longer matches the repo (stale
    // hunk, binary file, nothing to stage), which is the caller's to resolve.
    if (!out.ok) return res.status(400).json(out);
    broadcast();
    res.json(out);
  };
  api.post('/sessions/:id/hunks/stage', applyRoute('stage'));
  api.post('/sessions/:id/hunks/unstage', applyRoute('unstage'));
}

export { register, selection, resolveWorktree };
