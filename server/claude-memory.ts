/*
 * Share a repo's Claude Code memories with its worktrees.
 *
 * Claude Code keys per-project memory on the session's ABSOLUTE cwd:
 *
 *   ~/.claude/projects/<path with every non-alphanumeric byte turned into '-'>/memory/
 *
 * Studio runs every session with cwd set to a worktree, and a worktree is a different
 * path from the checkout it was cut from. So a repo with fifty accumulated memories —
 * commit style, review conventions, "never push" — hands a Studio session none of them,
 * and every memory that session writes lands in a directory that dies with the worktree.
 * Nothing reports this: the session simply behaves as though it had never met the user.
 *
 * The fix is the one `wt` already applies to run configs and gitignored config files:
 * carry across the per-path state a bare worktree silently omits. Here that means
 * pointing the worktree's memory directory at the checkout's, so a worktree reads the
 * repo's memories and anything it learns is written back where the next worktree — and
 * the checkout itself — will see it.
 *
 * A symlink rather than a copy, deliberately: memories are edited during a session, and
 * two copies would diverge the moment one did.
 *
 * ---- Safety ----
 *
 * This is the only code in Studio that writes inside ~/.claude, so it is conservative to
 * a fault. It NEVER deletes or overwrites a real memory directory: an existing directory
 * with anything in it is left exactly as it is and reported, because the alternative is
 * destroying memories to fix a convenience. It only ever replaces an empty directory, or
 * creates a link where nothing exists.
 */
import fs from 'fs';
import path from 'path';
import { HOME } from './util.ts';

/** Where Claude Code keeps per-project state. Overridable for tests. */
export const PROJECTS_DIR = process.env.WT_STUDIO_CLAUDE_PROJECTS || path.join(HOME, '.claude', 'projects');

/**
 * Claude Code's project-directory name for an absolute path.
 *
 * Every byte that is not a letter or a digit becomes '-', which is why
 * `/Users/d/code/api/.worktrees/x` becomes `-Users-d-code-api--worktrees-x` — the double
 * hyphen is the '/' and the '.' of `/.worktrees`, not a separator with meaning. Derived
 * by inspection of a real ~/.claude/projects, so it is a mirror of someone else's
 * convention: if Claude Code changes it, linking silently stops matching and the only
 * cost is that memories are not shared, which is exactly today's behaviour.
 */
export function projectDirName(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The memory directory Claude Code would use for a session run in `absPath`. */
export function memoryDirFor(absPath: string, projectsDir = PROJECTS_DIR): string {
  return path.join(projectsDir, projectDirName(absPath), 'memory');
}

/** What linkMemory did, so the caller can log it and tests can assert on it. */
export type LinkOutcome =
  /** The worktree now reads the checkout's memories (newly linked). */
  | { status: 'linked'; from: string; to: string }
  /** Already pointing at the right place — the common case after the first run. */
  | { status: 'already' }
  /** Same path, or no repo path: there is nothing to share. */
  | { status: 'skipped'; reason: string }
  /** Left alone rather than risk data: real memories, or a link somewhere else. */
  | { status: 'occupied'; reason: string; at: string }
  | { status: 'error'; error: string };

/**
 * Point `worktreePath`'s memory directory at `repoPath`'s.
 *
 * Idempotent and safe to call before every launch — the steady state is one `lstat`.
 * Returns what it did rather than throwing: a session must start whether or not its
 * memories could be shared.
 */
export function linkMemory(worktreePath: string, repoPath: string, projectsDir = PROJECTS_DIR): LinkOutcome {
  try {
    if (!worktreePath || !repoPath) return { status: 'skipped', reason: 'missing path' };
    // A session running IN the checkout already has the real directory.
    if (path.resolve(worktreePath) === path.resolve(repoPath)) {
      return { status: 'skipped', reason: 'session runs in the checkout itself' };
    }
    const target = memoryDirFor(repoPath, projectsDir);
    // Nothing to share. Deliberately not created: seeding empty memory directories for
    // every repo Studio has ever scanned would litter ~/.claude with dead folders, and
    // the first memory written in the checkout creates this anyway.
    if (!fs.existsSync(target)) return { status: 'skipped', reason: 'the checkout has no memories yet' };

    const link = memoryDirFor(worktreePath, projectsDir);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(link);
    } catch {
      /* absent — the normal first-run path */
    }

    if (st?.isSymbolicLink()) {
      const cur = fs.readlinkSync(link);
      if (path.resolve(path.dirname(link), cur) === path.resolve(target)) return { status: 'already' };
      // Somebody pointed this somewhere on purpose. Not ours to redirect.
      return { status: 'occupied', reason: 'already linked elsewhere', at: cur };
    }

    if (st?.isDirectory()) {
      // The one case worth being paranoid about: a real directory holding real memories.
      // Replacing it would delete them, so an occupied directory wins over the feature.
      if (fs.readdirSync(link).length) {
        return {
          status: 'occupied',
          reason: 'a real memory directory with content is already here',
          at: link,
        };
      }
      fs.rmdirSync(link); // empty — safe to stand a link in its place
    } else if (st) {
      return { status: 'occupied', reason: 'a non-directory is in the way', at: link };
    }

    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, 'dir');
    return { status: 'linked', from: link, to: target };
  } catch (e) {
    return { status: 'error', error: (e as Error).message };
  }
}

/** One repo of a session: where it is checked out, and where this session works. */
export interface RepoLike {
  repo?: string;
  repoPath?: string | null;
  worktreePath?: string | null;
}

/**
 * Link every repo a session spans.
 *
 * Per-repo, not per-session: a feature is several checkouts, and each worktree has to
 * reach its OWN repo's memories — pointing a frontend worktree at the backend's
 * memories would be worse than pointing it at nothing.
 */
export function linkSessionMemory(
  repos: RepoLike[] | null | undefined,
  projectsDir = PROJECTS_DIR,
): Array<{ repo?: string; outcome: LinkOutcome }> {
  return (repos || [])
    .filter((r) => r?.worktreePath && r.repoPath)
    .map((r) => ({ repo: r.repo, outcome: linkMemory(r.worktreePath!, r.repoPath!, projectsDir) }));
}
