// Reinstating a closed session.
//
// Closing a session deletes Studio's pointer; the CONVERSATION belongs to Claude Code
// and stays on disk. These two routes find those orphans and bring one back.
//
// The candidate list is built HERE rather than in server/reinstate.ts because it needs
// the repo scan, the worktree layout and which sessions are live — and because the
// lookup can only go forwards, from a path to its transcript. The slug is lossy (see
// reinstate.ts), so walking a transcript directory back to a worktree path is not
// possible at all. reinstate.ts stays the pure half: given candidates, which have a
// conversation and which of those can be recovered.
//
// `api` is the ONE router server.ts mounts at both /api and /api/v1 — see
// server/routes-review.ts for why registering onto it is what makes the two prefixes
// answer identically.
import fs from 'fs';
import type { Router } from 'express';
import * as layoutMod from './layout.ts';
import * as reinstate from './reinstate.ts';
import { realpath, requireBody, run } from './util.ts';
import * as worktree from './worktree.ts';
import type { ResolvedLayout } from './layout.ts';
import type { Config, PartialDeep, Session } from './types.ts';

const { worktreeCopyOpts } = worktree;

/** One scan-cache row, narrowed to what enumerating candidates reads. */
interface ScanRepo {
  name: string;
  path: string;
  worktrees?: Array<{ path: string; name?: string | null; branch?: string | null; isMain?: boolean }> | null;
}

/** A candidate worktree: one that might have a conversation waiting for it. */
interface Candidate {
  worktreePath: string;
  repo: string;
  name: string;
  branch: string;
  branchExists: boolean;
  repoPath: string;
}

interface OrphansDeps {
  /** Read for the copy patterns a recreated worktree needs. */
  cfg: PartialDeep<Config>;
  manager: {
    all(): Array<Pick<Session, 'worktreePath' | 'repos'>>;
    adopt(args: {
      worktreePath: string;
      repoName: string;
      repoPath: string;
      branch: string;
      wtname: string;
      resumeId?: string;
    }): Promise<Session | null>;
  };
  repos: () => ScanRepo[];
  /** The worktree layout in force — where a branch's worktree WOULD live. */
  layout: ResolvedLayout;
  rescan: () => Promise<unknown>;
  broadcastTopology: () => void;
}

function register(api: Router, deps: OrphansDeps): void {
  const { cfg, manager, repos, layout, rescan, broadcastTopology } = deps;

  async function orphanCandidates(): Promise<Candidate[]> {
    const taken = new Set(
      manager
        .all()
        .flatMap((s) => [s.worktreePath, ...(s.repos || []).map((r) => r.worktreePath)])
        .filter((p): p is string => !!p)
        .map((p) => realpath(p)),
    );
    const out: Candidate[] = [];

    for (const r of repos()) {
      // Worktrees that exist right now and have no session — the common orphan.
      for (const w of r.worktrees || []) {
        if (w.isMain || !w.path || taken.has(realpath(w.path))) continue;
        out.push({
          worktreePath: w.path,
          repo: r.name,
          name: w.name || '',
          branch: w.branch || '',
          branchExists: true, // it is checked out, so it exists by definition
          repoPath: r.path,
        });
      }
      /*
       * And worktrees that are GONE: for every local branch with no worktree, the path one
       * WOULD occupy. Deterministic from the layout, which is what makes this findable at
       * all — the transcript itself cannot be mapped back to a path (the slug is lossy).
       *
       * Enumerated LAZILY, here, rather than added to ScannedRepo: that would put a git
       * call per repo on every scan — which fires whenever a file changes — to answer a
       * question nobody asks until they open this list.
       */
      const raw = await run('git', ['-C', r.path, 'branch', '--format=%(refname:short)']);
      const live = new Set((r.worktrees || []).map((w) => w.path));
      for (const b of raw.stdout
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)) {
        const name = b.split('/').pop() || b;
        const dest = layoutMod.destFor(layout, r.path, name);
        if (live.has(dest) || taken.has(realpath(dest))) continue;
        out.push({ worktreePath: dest, repo: r.name, name, branch: b, branchExists: true, repoPath: r.path });
      }
    }
    return out;
  }

  api.get('/orphans', async (_req, res) => {
    const cands = await orphanCandidates();
    res.json({ orphans: reinstate.findOrphans(cands) });
  });

  /**
   * Bring one back: recreate the worktree if it is missing, then adopt with `--resume`.
   *
   * Refuses rather than improvises when the branch is gone — recreating then would give an
   * empty branch off the default with a transcript attached, i.e. an agent resuming into a
   * directory that does not hold the code it is discussing.
   */
  api.post('/orphans/reinstate', async (req, res) => {
    const asked = requireBody(res, req.body, ['worktreePath']);
    if (!asked.ok) return;
    const { worktreePath } = asked.value;

    const cand = (await orphanCandidates()).find((c) => c.worktreePath === worktreePath);
    if (!cand) return res.status(404).json({ ok: false, error: 'nothing to reinstate at that path' });
    const [orphan] = reinstate.findOrphans([cand]);
    if (!orphan)
      return res.status(404).json({ ok: false, error: 'no conversation was found for that worktree' });
    if (!orphan.recoverable) return res.status(409).json({ ok: false, error: orphan.reason });

    if (!fs.existsSync(worktreePath)) {
      // The branch exists — that is what `recoverable` checked — so this checks it out at
      // the path the transcript is keyed to, which is what makes --resume find it.
      const made = await worktree.create(cand.repoPath, cand.branch, cand.name, {
        fetch: false,
        layout,
        ...worktreeCopyOpts(cfg, cand.repo),
      });
      if (!made.ok) return res.status(400).json({ ok: false, error: made.error });
      await rescan();
    }

    const s = await manager.adopt({
      worktreePath,
      repoName: cand.repo,
      repoPath: cand.repoPath,
      branch: cand.branch,
      wtname: cand.name,
      resumeId: orphan.claudeSessionId,
    });
    broadcastTopology();
    if (!s)
      return res.status(409).json({ ok: false, error: 'a session for that worktree is already opening' });
    res.json({ ok: true, session: s });
  });
}

export { register };
