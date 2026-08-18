/*
 * Bringing a closed session's conversation back.
 *
 * Studio's session record is a thin pointer. The conversation itself belongs to Claude
 * Code and lives at `~/.claude/projects/<slug-of-cwd>/<uuid>.jsonl` — so closing a session
 * deletes Studio's pointer and leaves the transcript untouched. Reinstating is rebuilding
 * the pointer and relaunching with `--resume`.
 *
 * TWO FACTS SHAPE THIS ENTIRELY.
 *
 * 1. `--resume` finds a conversation by slugging the CURRENT WORKING DIRECTORY. No
 *    directory, no lookup. So a transcript whose worktree is gone cannot be resumed where
 *    it lies — the path has to exist again first.
 *
 * 2. The slug is LOSSY. projectDirName() replaces every non-alphanumeric with '-', so
 *    `foo/bar`, `foo.bar` and `foo-bar` all produce the same directory name. You cannot
 *    walk from a transcript folder back to a worktree path; only forwards, from a path you
 *    already know. Everything below therefore enumerates CANDIDATE paths and asks whether
 *    each has a transcript — never the reverse.
 *
 * WHAT IS DELIBERATELY NOT HERE: recreating a worktree whose branch is gone. That yields
 * an empty branch off the default with a transcript attached — an agent resuming into a
 * directory that does not contain the code it is discussing. Refusing is better than
 * faking it, so `recoverable` is false and the caller says why.
 */
import fs from 'fs';
import path from 'path';
import { PROJECTS_DIR, projectDirName } from './claude-memory.ts';

/** One resumable conversation, and everything needed to bring it back. */
export interface Orphan {
  /** The worktree the conversation happened in — which may not exist right now. */
  worktreePath: string;
  repo: string;
  /** The worktree directory name, which is also the feature name under `basename`. */
  name: string;
  branch: string;
  /** Claude's own conversation id — the `--resume` argument. */
  claudeSessionId: string;
  /** When that conversation was last written to. */
  lastModified: number;
  /** How many conversations the directory holds; >1 means the newest was picked. */
  conversations: number;
  /** False when the branch is gone: the code is not recoverable, so neither is the work. */
  recoverable: boolean;
  /** Present when `recoverable` is false — what the user is being told. */
  reason?: string;
}

/** The newest `<uuid>.jsonl` in a transcript directory, or null when there is none. */
function newestConversation(dir: string): { id: string; mtime: number; count: number } | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  if (!entries.length) return null;
  /*
   * The FILENAME is the conversation id — that is the whole recovery mechanism, since
   * Studio's own `claudeSessionId` was deleted along with the session record.
   *
   * The newest is picked rather than offering all of them: several conversations in one
   * worktree means the session was closed and restarted there, and the most recent is
   * what "resume this work" means. `conversations` is reported so the UI can say so.
   */
  const stated = entries
    .map((f) => {
      try {
        return { id: path.basename(f, '.jsonl'), mtime: fs.statSync(path.join(dir, f)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { id: string; mtime: number } => !!x)
    .sort((a, b) => b.mtime - a.mtime);
  if (!stated.length) return null;
  return { id: stated[0].id, mtime: stated[0].mtime, count: stated.length };
}

/** Does this worktree path have a conversation on disk? */
export function conversationFor(
  worktreePath: string,
  projectsDir = PROJECTS_DIR,
): { id: string; mtime: number; count: number } | null {
  return newestConversation(path.join(projectsDir, projectDirName(worktreePath)));
}

/**
 * Candidate worktrees with a conversation and no live session.
 *
 * `candidates` is every worktree Studio knows about — from the scan, so paths are real —
 * plus, for a worktree that no longer exists, the path it WOULD occupy. The caller builds
 * that list because only it knows the layout and which sessions are live.
 */
export function findOrphans(
  candidates: Array<{
    worktreePath: string;
    repo: string;
    name: string;
    branch: string;
    branchExists: boolean;
  }>,
  projectsDir = PROJECTS_DIR,
): Orphan[] {
  const out: Orphan[] = [];
  for (const c of candidates) {
    const conv = conversationFor(c.worktreePath, projectsDir);
    if (!conv) continue; // nothing to resume — a fresh start is the honest offer
    const onDisk = fs.existsSync(c.worktreePath);
    /*
     * A worktree that is still on disk needs no recreation, so it is always recoverable.
     * One that is gone needs its branch back, and only the branch carries the code.
     */
    const recoverable = onDisk || c.branchExists;
    out.push({
      worktreePath: c.worktreePath,
      repo: c.repo,
      name: c.name,
      branch: c.branch,
      claudeSessionId: conv.id,
      lastModified: conv.mtime,
      conversations: conv.count,
      recoverable,
      ...(recoverable
        ? {}
        : {
            reason: onDisk
              ? 'the worktree is there but its branch is gone'
              : `the worktree and the branch "${c.branch}" are both gone, so the code cannot be brought back — the conversation is still searchable (⌘⇧F)`,
          }),
    });
  }
  return out.sort((a, b) => b.lastModified - a.lastModified);
}
