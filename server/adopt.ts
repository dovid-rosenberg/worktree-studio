/*
 * Healing worktrees Studio did not create.
 *
 * A worktree made by anything other than `worktree.create()` — an agent running `git
 * worktree add`, a hand-rolled one, anything predating Studio — is already FOUND: `git
 * worktree list` does not care who ran it, so server/git.ts reports it, identity.ts
 * groups it into its feature, and it shows up in the topology like any other. Discovery
 * was never the gap.
 *
 * The gap is that the copy step only ever ran inside create(), so such a worktree has no
 * run configs and none of the gitignored local config — and NOTHING SAYS SO. The Run
 * menu is simply empty and the app quietly falls back to default config. That silent
 * failure is the entire reason "never run `git worktree add`, use `wt`" had to be
 * written down as a rule, and a rule an agent can forget is not an invariant. This is
 * the invariant: the scan that finds the worktree also heals it.
 *
 * Scoped to what a scan can know. Backfill only ADDS missing files (see
 * worktree.backfill), so this can never overwrite an agent's edits, and it is safe to
 * run against every worktree the daemon has never looked at — including, at boot, ones
 * that have existed for weeks and were missing their run configs the whole time. That
 * is `wt sync`, arriving on its own.
 */
import * as worktreeMod from './worktree.ts';
import type { ScannedRepo } from './git.ts';
import type { Config, PartialDeep } from './types.ts';
import type { CopyCounts } from './worktree.ts';

const { worktreeCopyOpts } = worktreeMod;

/** One worktree that was missing something, and what it got. */
export interface AdoptReport {
  repo: string;
  worktree: string;
  path: string;
  copied: CopyCounts;
}

export interface AdopterDeps {
  cfg: PartialDeep<Config> | null | undefined;
  /** Injectable for tests; defaults to the real copy step. */
  backfill?: (
    repoPath: string,
    dest: string,
    opts: Partial<worktreeMod.WorktreeCopyOpts>,
  ) => Promise<CopyCounts>;
}

/**
 * Build the pass that runs after each scan. Returns only the worktrees that were
 * actually missing something — a worktree that needed nothing is the common case and
 * must not produce a line, or the log stops meaning anything.
 */
export function createAdopter({ cfg, backfill = worktreeMod.backfill }: AdopterDeps) {
  // Worktrees this process has already looked at. The scan re-runs on every filesystem
  // event a repo produces — a commit, a push, a branch switch — so without this the
  // daemon would shell out `git check-ignore` per pattern per worktree several times a
  // minute, forever. Deliberately not persisted: backfill is idempotent, so the worst a
  // restart costs is one extra look.
  const seen = new Set<string>();

  return async function adoptScanned(repos: ScannedRepo[]): Promise<AdoptReport[]> {
    const report: AdoptReport[] = [];
    for (const repo of repos) {
      for (const wt of repo.worktrees || []) {
        // The main checkout is not a worktree to heal — it is the SOURCE the copies
        // come from.
        if (wt.isMain || !wt.path) continue;
        if (seen.has(wt.path)) continue;
        seen.add(wt.path);
        try {
          const copied = await backfill(repo.path, wt.path, worktreeCopyOpts(cfg, repo.name));
          if (copied.runConfigs || copied.files) {
            report.push({ repo: repo.name, worktree: wt.name, path: wt.path, copied });
          }
        } catch {
          // A worktree that raced with a remove, or one we cannot read, is not worth the
          // rest of the scan — the scan IS the topology and it has to finish.
        }
      }
    }
    return report;
  };
}

/** One line per healed worktree, for the boot/rescan log. */
export function describeAdoption(r: AdoptReport): string {
  const bits: string[] = [];
  if (r.copied.runConfigs) bits.push(`${r.copied.runConfigs} run config(s)`);
  if (r.copied.files) bits.push(`${r.copied.files} local file(s)`);
  return `adopted ${r.repo}/${r.worktree}: backfilled ${bits.join(' + ')}`;
}
