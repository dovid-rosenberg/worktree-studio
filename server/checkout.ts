// Getting a repo's MAIN checkout ready for a new session.
//
// A session starts in the main checkout and is promoted to a worktree later, so whatever
// that checkout happens to be sitting on is what the agent starts from. In practice it is
// sitting on the last thing you were doing: a half-finished feature branch, someone
// else's fix, six untracked scratch files. The agent then reads that as its starting
// state, and promote offers to drag it along.
//
// So a new session begins on the repo's DEFAULT branch, at its latest commit.
//
// The hard constraint is that this checkout is SHARED — it is the one working copy, not a
// worktree of our own — so nothing here may ever lose work. Three rules follow, and they
// are the whole design:
//
//   1. Fetch always. It is read-only, and it is what makes "latest" true rather than
//      "latest as of whenever you last fetched".
//   2. Switch branch only when the tree is CLEAN of tracked modifications. Untracked
//      files survive a checkout, so they do not block it; modified tracked files would be
//      carried onto another branch, which is a surprise nobody asked for.
//   3. Fast-forward only. Never reset, never rebase, never force. If the local default
//      branch has diverged from the remote, say so and leave it.
//
// Every refusal is REPORTED, not swallowed: a session that started somewhere other than
// where you expected should say which branch it is on and why.
import { run } from './util.ts';

/** How long a fetch may hold up a session launch before we give up and carry on. */
const FETCH_TIMEOUT_MS = 15000;

export interface PrepareResult {
  /** The branch the checkout is on when this returns. */
  branch: string;
  /** The repo's default branch, per `origin/HEAD`. */
  defaultBranch: string;
  fetched: boolean;
  /** Whether this call moved the checkout onto the default branch. */
  switched: boolean;
  /** Whether this call fast-forwarded the branch to its remote. */
  updated: boolean;
  /**
   * Why it did less than asked, in words for the session's activity line. Absent when
   * everything happened.
   */
  reason?: string;
}

export interface PrepareOptions {
  /** Skip the branch switch but still fetch — used when another session shares this checkout. */
  switchBranch?: boolean;
  fetchTimeoutMs?: number;
}

const git = async (repoPath: string, args: string[]) => run('git', ['-C', repoPath, ...args]);

/** The repo's default branch, or '' when there is no `origin/HEAD` to read. */
export async function defaultBranchOf(repoPath: string): Promise<string> {
  const sym = await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  return sym.stdout.trim().replace(/^origin\//, '');
}

/**
 * Tracked files with staged or unstaged modifications.
 *
 * Untracked files are deliberately NOT counted: `git checkout` carries them across
 * without complaint, so they are not a reason to refuse. Counting them would have
 * blocked the switch on a checkout whose only "changes" were six scratch scripts.
 */
export async function trackedModifications(repoPath: string): Promise<string[]> {
  const r = await git(repoPath, ['status', '--porcelain', '--untracked-files=no']);
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function prepareForSession(repoPath: string, opts: PrepareOptions = {}): Promise<PrepareResult> {
  const current = async () => (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();

  const startedOn = await current();
  const base: PrepareResult = {
    branch: startedOn,
    defaultBranch: '',
    fetched: false,
    switched: false,
    updated: false,
  };

  // Read-only, so it runs whatever else we decide. Bounded, because a slow or
  // unreachable remote must not hold a session launch open indefinitely.
  const fetched = await run('git', ['-C', repoPath, 'fetch', '--prune', 'origin'], {
    timeout: opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
  });
  base.fetched = fetched.code === 0;

  const def = await defaultBranchOf(repoPath);
  base.defaultBranch = def;
  if (!def) return { ...base, reason: 'this repo has no origin/HEAD, so it has no default branch' };

  if (opts.switchBranch === false) {
    return { ...base, reason: `left on ${startedOn}` };
  }

  if (startedOn !== def) {
    const dirty = await trackedModifications(repoPath);
    if (dirty.length) {
      return {
        ...base,
        reason: `left on ${startedOn}: ${dirty.length} uncommitted change(s) would have come along`,
      };
    }
    const co = await git(repoPath, ['checkout', def]);
    if (co.code !== 0) {
      return { ...base, reason: `could not switch to ${def}: ${co.stderr.trim().split('\n')[0]}` };
    }
    base.switched = true;
    base.branch = def;
  }

  // Fast-forward ONLY. A diverged local default branch is a situation to report, not one
  // to resolve behind the user's back.
  const ff = await git(repoPath, ['merge', '--ff-only', `origin/${def}`]);
  if (ff.code === 0) {
    base.updated = !/Already up to date/i.test(ff.stdout);
    return base;
  }
  return {
    ...base,
    reason: `${def} could not fast-forward to origin/${def} — it has diverged, so it was left as it is`,
  };
}

/**
 * One line for the session's activity, or '' when everything went as intended and there
 * is nothing worth saying.
 */
export function describe(r: PrepareResult): string {
  if (r.reason) return r.reason;
  if (r.switched && r.updated) return `on ${r.branch}, updated`;
  if (r.switched) return `on ${r.branch}`;
  if (r.updated) return `${r.branch} updated`;
  return '';
}
