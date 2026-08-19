// The branch review: what has been committed on a worktree's branch, what one of
// those commits changed, and committing from the UI.
//
// Distinct from server/routes-review.ts, which owns the structured diff model and
// hunk-level staging. This module answers the coarser question the Review pane opens
// with — "what is in here, and is it merged?" — for a SESSION and for a FEATURE.
//
// Those two used to be separate 25-line copies of the same rollup in the composition
// root that differed only in where they got the worktree path from, so a fix to one (a
// vanished worktree being reported as a clean, empty review) had to be applied to both
// or one of them would go on lying. There is one rollup here, and both routes call it.
//
// `api` is the ONE router server.ts mounts at both /api and /api/v1 — see
// server/routes-review.ts for why registering onto it is what makes the two prefixes
// answer identically.
import fs from 'fs';
import type { Router } from 'express';
import * as review from './review.ts';
import { defaultBranchOf, qs, requireFeature, requireSession } from './util.ts';

/** A session's repo, as far as these routes are concerned. */
interface CommitRepo {
  repo: string;
  worktreePath?: string | null;
  branch?: string | null;
}

interface CommitSession {
  repos?: CommitRepo[] | null;
}

/** One feature member: the same three fields a session repo contributes. */
interface CommitMember {
  repo: string;
  path?: string | null;
  branch?: string | null;
}

/** One scan-cache row, narrowed to the field the base-branch lookup reads. */
interface ScanRepo {
  name: string;
  defaultBranch?: string | null;
}

interface CommitsDeps {
  manager: { get(id: string): CommitSession | null | undefined };
  repos: () => ScanRepo[];
  resolveGroup: (name: string) => Promise<{ group: { members: CommitMember[] } | null }>;
  /**
   * A commit landed through the UI.
   *
   * One callback rather than three collaborators because the module has no opinion on
   * what a new commit means: the composition root does (push the topology, force a CI
   * poll, recompute overlap). See server.ts for what is behind it.
   */
  onCommit?: () => void;
}

function register(api: Router, deps: CommitsDeps): void {
  const { manager, repos, resolveGroup, onCommit } = deps;

  /** Bound here rather than passed as `manager.get`, which would lose its receiver. */
  const getSession = (id: string) => manager.get(id);

  // A repo's default branch, or 'main' when the scan cache doesn't know it. The rule
  // itself lives in util.ts now — routes-review.ts had a second copy of this closure,
  // and two spellings of one fallback is how the two panes come to disagree on a base.
  const defaultBranch = (name: string): string => defaultBranchOf(repos(), name);

  /**
   * One repo's review rollup: its commits, its base, and what is uncommitted.
   */
  async function reviewRollup(repo: string, worktreePath: string, branch?: string | null) {
    /*
     * A worktree that is gone is REPORTED, not reviewed as empty.
     *
     * util.git() returns '' for any non-zero exit, including a missing cwd — so every git
     * call quietly answered nothing and the response was byte-for-byte identical to a
     * healthy branch with no changes: zero commits, zero files, and a fabricated `base`
     * that no command had produced. If your work was in that worktree, the Review pane
     * told you everything was fine and empty.
     */
    if (!fs.existsSync(worktreePath)) {
      return {
        repo,
        worktreePath,
        branch,
        error: 'this worktree is no longer on disk',
        commits: [],
        uncommitted: { fileCount: 0, added: 0, deleted: 0 },
      };
    }
    const def = defaultBranch(repo);
    const { base, commits } = await review.commits(worktreePath, def);
    const wc = await review.working(worktreePath);
    return {
      repo,
      worktreePath,
      branch,
      base,
      defaultBranch: def,
      commits,
      uncommitted: {
        fileCount: wc.files.length,
        added: wc.files.reduce((n, f) => n + (f.added || 0), 0),
        deleted: wc.files.reduce((n, f) => n + (f.deleted || 0), 0),
      },
    };
  }

  /*
   * The same rollup for a FEATURE rather than a session.
   *
   * /sessions/:id/commits is keyed on a session, so a feature with no agent — the exact
   * case the dock's feature pane exists for — could not answer "what is in here, and is
   * it merged?" without starting one. Same shape, so the client renders both the same
   * way.
   */
  api.get('/group/:name/commits', async (req, res) => {
    const found = await requireFeature(res, resolveGroup, req.params.name);
    if (!found.ok) return;
    const out = [];
    for (const m of found.value.group.members) {
      if (!m.path) continue;
      out.push(await reviewRollup(m.repo, m.path, m.branch));
    }
    res.json({ repos: out });
  });

  api.get('/sessions/:id/commits', async (req, res) => {
    const s = requireSession(res, getSession, req.params.id);
    if (!s.ok) return;
    const out = [];
    for (const entry of s.value.repos || []) {
      if (!entry.worktreePath) continue;
      out.push(await reviewRollup(entry.repo, entry.worktreePath, entry.branch));
    }
    res.json({ repos: out });
  });

  api.get('/sessions/:id/commit-detail', async (req, res) => {
    const s = requireSession(res, getSession, req.params.id);
    if (!s.ok) return;
    const entry = (s.value.repos || []).find((r) => r.repo === qs(req.query.repo));
    if (!entry?.worktreePath) return res.status(400).json({ error: 'unknown repo or no worktree' });
    const sha = qs(req.query.sha) || 'uncommitted';
    // Same boundary check as routes-review.ts: `sha` reaches a git argv, so it has
    // to be an object name and not an option (see server/review.ts).
    if (!review.isValidSha(sha))
      return res.status(400).json({ error: 'sha must be a hex object name or "uncommitted"' });
    res.json(await review.commitDetail(entry.worktreePath, defaultBranch(entry.repo), sha));
  });

  api.post('/sessions/:id/commit', async (req, res) => {
    // 404, like its three neighbours and like the table in docs/api.md: this one
    // answered 400 for an unknown session, which is the status for a bad FIELD.
    const s = requireSession(res, getSession, req.params.id);
    if (!s.ok) return;
    const { repo, message, paths, amend } = req.body || {};
    const entry = (s.value.repos || []).find((r) => r.repo === repo);
    if (!entry?.worktreePath) return res.status(400).json({ error: 'unknown repo or no worktree' });
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
    const out = await review.commit(entry.worktreePath, message, { amend, paths });
    // A commit made through the UI writes refs/heads/<branch>, so the watcher would
    // find it anyway — but it can take a debounce plus a scan to get here, and we
    // already know. Poke directly rather than wait to be told what we just did.
    if (out.ok) onCommit?.();
    res.json(out);
  });
}

export { register };
