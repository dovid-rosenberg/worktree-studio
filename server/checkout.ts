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
import { gitFull, run } from './util.ts';
import { originHead, porcelainStatus } from './git.ts';

/** How long a fetch may hold up a session launch before we give up and carry on. */
const FETCH_TIMEOUT_MS = 15000;

export interface PrepareResult {
  /** The branch the checkout is on when this returns. */
  branch: string;
  /** The repo's default branch, per `origin/HEAD`. */
  defaultBranch: string;
  /**
   * Whether `git fetch` succeeded. READ IT — a false here invalidates the freshness this
   * whole module exists to provide, and it used to be recorded and never looked at.
   */
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
  /** Present only when the fetch failed; the first line of git's complaint. */
  fetchError?: string;
}

/** git puts the useful half of a failure on the first line and the advice below it. */
function firstLine(s: string): string {
  return String(s || '')
    .trim()
    .split('\n')[0]
    .trim();
}

export interface PrepareOptions {
  /** Skip the branch switch but still fetch — used when another session shares this checkout. */
  switchBranch?: boolean;
  fetchTimeoutMs?: number;
}

/**
 * The repo's default branch, or '' when there is no `origin/HEAD` to read.
 *
 * `originHead` rather than `defaultBranch`, deliberately: this module must be able to
 * tell "there is no default branch" from a guess. `prepareForSession` REFUSES to switch
 * when it gets '', and switching to an invented 'main' would be exactly the wrong move —
 * it would either fail or land the session somewhere nobody asked for.
 */
export async function defaultBranchOf(repoPath: string): Promise<string> {
  return (await originHead(repoPath)).replace(/^origin\//, '');
}

/**
 * Paths of tracked files with staged or unstaged modifications.
 *
 * Untracked files are deliberately NOT counted: `git checkout` carries them across
 * without complaint, so they are not a reason to refuse. Counting them would have
 * blocked the switch on a checkout whose only "changes" were six scratch scripts.
 */
export async function trackedModifications(repoPath: string): Promise<string[]> {
  return (await porcelainStatus(repoPath, { untracked: false })).map((e) => e.path);
}

/**
 * Why a checkout is not free.
 *
 * There is deliberately no `branch` reason. "Sitting on a feature branch" was one, and
 * it made a CLEAN checkout occupied — which fed `switchBranch: !occupied` and quietly
 * cancelled the thing prepareForSession() exists to do: start from the default branch at
 * its latest commit. A branch you left behind is not somebody working; it is the state
 * every checkout is in between tasks, and switching away from it is safe because
 * `dirty` already covers the only case where it would not be.
 */
export type OccupiedReason = 'session' | 'dirty';

export type Occupancy = { occupied: false } | { occupied: true; reason: OccupiedReason; detail: string };

/**
 * Is this repo's ONE working copy already someone's?
 *
 * A repo has a single main checkout, and `create()` used to start every un-promoted
 * session in it. Two sessions in one repo therefore shared a working copy by design:
 * one would commit the other's half-finished edits, or switch the branch under it. That
 * is not a race — it is what the flow did on purpose, and `prepareForSession()`'s
 * `switchBranch: false` was as far as tolerating it could go.
 *
 * This asks the prior question instead, and asks it of the FILESYSTEM. `held` covers the
 * case Studio can see — one of its own sessions is living there — but an agent nobody
 * launched through Studio leaves no record at all, only evidence: tracked files modified.
 * A registry cannot see that one, which is why the answer cannot come from a registry.
 *
 * Being occupied is not a refusal, and it does not mean the same thing for both reasons.
 * `session` is a collision, and create() gives the new session its own worktree. `dirty`
 * only means nothing may MOVE this checkout — the session still starts in it, because
 * unfinished edits are the ordinary state of a checkout between tasks.
 */
export async function occupancy(
  repoPath: string,
  { held = false }: { held?: boolean } = {},
): Promise<Occupancy> {
  if (held)
    return { occupied: true, reason: 'session', detail: 'another session is working in this checkout' };

  const dirty = await trackedModifications(repoPath);
  if (dirty.length) {
    return {
      occupied: true,
      reason: 'dirty',
      detail: `the checkout has ${dirty.length} uncommitted change(s)`,
    };
  }
  return { occupied: false };
}

export async function prepareForSession(repoPath: string, opts: PrepareOptions = {}): Promise<PrepareResult> {
  const current = async () => (await gitFull(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();

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
  /*
   * A failed fetch is a REPORTED outcome, not a skipped step.
   *
   * Everything below still works when the remote is unreachable — the switch succeeds,
   * the fast-forward is a clean no-op against a stale `origin/<default>` — and the
   * session then starts on a branch that is confidently out of date. With nothing said,
   * that is indistinguishable from a correct, up-to-date start. On a dropped VPN or a
   * 15s timeout that is precisely the wrong thing to be quiet about.
   */
  if (!base.fetched) {
    base.fetchError = firstLine(fetched.stderr) || 'could not reach origin';
  }

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
    const co = await gitFull(repoPath, ['checkout', def]);
    if (co.code !== 0) {
      return { ...base, reason: `could not switch to ${def}: ${co.stderr.trim().split('\n')[0]}` };
    }
    base.switched = true;
    base.branch = def;
  }

  // Fast-forward ONLY. A diverged local default branch is a situation to report, not one
  // to resolve behind the user's back.
  const ff = await gitFull(repoPath, ['merge', '--ff-only', `origin/${def}`]);
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
  const rest = () => {
    if (r.reason) return r.reason;
    if (r.switched && r.updated) return `on ${r.branch}, updated`;
    if (r.switched) return `on ${r.branch}`;
    if (r.updated) return `${r.branch} updated`;
    return '';
  };
  const tail = rest();
  // The stale-branch warning leads, because it changes what every other clause MEANS:
  // "on develop, updated" against an unreachable origin is up to date with nothing.
  if (!r.fetched) {
    const why = `could not fetch origin (${r.fetchError || 'unknown'}) — this branch may be out of date`;
    return tail ? `${why}; ${tail}` : why;
  }
  return tail;
}
