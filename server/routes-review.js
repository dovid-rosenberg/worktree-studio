'use strict';
// Routes for the structured diff model and hunk-level staging. Self-contained on
// purpose: server.js wires this in with a single `register(app, deps)` call, so the
// route table can grow here without touching it again.
//
// Every route is mounted twice — under /api (what the current client calls) and under
// /api/v1 (the versioned path new clients should use). Same handler, same behaviour;
// the pair exists so the unversioned path can be retired later without a flag day.
const review = require('./review');
const hunks = require('./hunks');

const PREFIXES = ['/api', '/api/v1'];

// Same async wrapper server.js uses: a rejected handler becomes a 500 instead of an
// unhandled rejection (Express 4 doesn't await handlers).
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[wt-studio]', e);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

// Resolve :id + ?repo (or body.repo) to the worktree the operation runs in. Returns
// { entry } or { status, error } so each handler bails the same way.
function resolveWorktree(deps, req, repoName) {
  const session = deps.manager.get(req.params.id);
  if (!session) return { status: 404, error: 'no such session' };
  const list = (session.repos || []).filter((r) => r.worktreePath);
  // With one repo the name is redundant — don't make callers pass it.
  const entry = repoName ? list.find((r) => r.repo === repoName) : list.length === 1 ? list[0] : null;
  if (!entry) return { status: 400, error: repoName ? `unknown repo '${repoName}'` : 'repo is required' };
  return { entry, session };
}

// The hunk indexes a request is acting on: `hunks: [0,2]` or the `hunk: 0` shorthand.
function selection(body) {
  if (Array.isArray(body.hunks)) return body.hunks;
  if (body.hunks != null) return [body.hunks];
  if (body.hunk != null) return [body.hunk];
  return [];
}

// register(app, deps) — deps: { manager, repos, broadcast? }. `repos` may be the scan
// cache array or a getter for it; server.js rebuilds that array on every rescan, so it
// passes a getter and this module never holds a stale reference.
function register(app, deps) {
  const { repos } = deps || {};
  if (!deps || !deps.manager) throw new Error('routes-review: deps.manager is required');
  const broadcast = deps.broadcast || (() => {});
  const defaultBranchOf = (name) => {
    const list = typeof repos === 'function' ? repos() : repos || [];
    const hit = list.find((r) => r.name === name);
    return hit && hit.defaultBranch;
  };
  const get = (p, fn) => PREFIXES.forEach((pre) => app.get(pre + p, wrap(fn)));
  const post = (p, fn) => PREFIXES.forEach((pre) => app.post(pre + p, wrap(fn)));

  // The structured per-file diff for one commit, or for the working tree when
  // sha=uncommitted (the default). Each file carries the raw patch AND the parsed
  // model — hunks, aligned rows, line numbers on both sides.
  get('/sessions/:id/diff', async (req, res) => {
    const r = resolveWorktree(deps, req, req.query.repo);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const sha = req.query.sha || 'uncommitted';
    // Reject at the boundary, so a `sha` that is really a git option never reaches
    // an argv (see review.js). A bad request is a 400, not a 500.
    if (!review.isValidSha(sha)) return res.status(400).json({ error: 'sha must be a hex object name or "uncommitted"' });
    const detail = await review.commitDetail(r.entry.worktreePath, defaultBranchOf(r.entry.repo), sha);
    res.json({ repo: r.entry.repo, worktreePath: r.entry.worktreePath, sha, files: detail.files });
  });

  // Both sides of one working file, split the way staging needs them: `unstaged` hunks
  // can be staged, `staged` hunks can be unstaged. Hunk indexes in the two POSTs below
  // refer to the matching side of THIS payload.
  get('/sessions/:id/hunks', async (req, res) => {
    const r = resolveWorktree(deps, req, req.query.repo);
    if (r.error) return res.status(r.status).json({ error: r.error });
    if (!req.query.file) return res.status(400).json({ error: 'file is required' });
    res.json(await hunks.fileHunks(r.entry.worktreePath, String(req.query.file)));
  });

  // Stage / unstage individual hunks. This sits alongside file-level staging (the
  // `paths` argument of POST /sessions/:id/commit) rather than replacing it — some
  // changes (binary, mode-only) can only be staged whole, and that is what the error
  // from these routes says.
  const applyRoute = (op) => async (req, res) => {
    const body = req.body || {};
    const r = resolveWorktree(deps, req, body.repo);
    if (r.error) return res.status(r.status).json({ error: r.error });
    const out = await hunks[op](r.entry.worktreePath, {
      file: body.file, hunks: selection(body), expect: body.expect,
    });
    // 400, not 500: a refusal here means the request no longer matches the repo (stale
    // hunk, binary file, nothing to stage), which is the caller's to resolve.
    if (!out.ok) return res.status(400).json(out);
    broadcast();
    res.json(out);
  };
  post('/sessions/:id/hunks/stage', applyRoute('stage'));
  post('/sessions/:id/hunks/unstage', applyRoute('unstage'));
}

module.exports = { register, PREFIXES, selection, resolveWorktree };
