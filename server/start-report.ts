/*
 * What a batch of dev-server launches actually achieved — decided in ONE place.
 *
 * There are two routes that bring a stack up: `/group/start` (a whole feature) and
 * `/sessions/:id/servers/start` (the repos one session owns). They were two independent
 * implementations of the same three-part judgement, and only one of them was ever fixed:
 *
 *   - a member that CANNOT start is dropped from the batch and never mentioned, so a
 *     two-repo feature whose BE worktree has no node_modules answers `started: 1, total: 1`,
 *     byte-identical to a full success;
 *   - `ok` is `some(r.ok)`, so one repo of three coming up is a win;
 *   - `listening === false` — spawned, never bound a port — counts as started, which is
 *     the exact shape of "it said it started and nothing is running".
 *
 * All three are the same bug wearing different clothes: a launch that reports success
 * and leaves you with no server. The group route grew the cure; the session route kept
 * all three defects, so pressing a different button reproduced the original complaint.
 * Hence this module. The rule now has one implementation, and the next route to start a
 * server inherits it rather than re-deriving it.
 */

/** The fields of `servers.decorate()` this judgement needs. */
export interface Startable {
  repo: string;
  path: string;
  running?: boolean;
  canStart?: boolean;
  depsMissing?: boolean;
  noStartCmd?: boolean;
}

/** One member that should be up and cannot be, with the reason it cannot. */
export interface SkippedMember {
  repo: string;
  path: string;
  reason: string;
}

/** What `servers.startAll()` reports back per repo. */
export interface StartOutcome {
  repo: string;
  ok: boolean;
  error?: string;
  /** `false` means the process spawned and no port ever listened; `undefined` = not checked. */
  listening?: boolean;
  /** Ports it bound that are not the ones its slot expects. */
  boundElsewhere?: number[];
}

export interface StartReport {
  ok: boolean;
  started: number;
  total: number;
  skipped: SkippedMember[];
  failures: Array<{ repo: string; error?: string }>;
}

/**
 * Why `canStart` is false, in words the UI can show verbatim.
 *
 * `canStart` is `configured && !depsMissing` (servers.decorate), so a false value has
 * exactly two causes and both are fixable by the user — one with the Install button, one
 * by adding the repo to `config.start`. Naming them is the whole point: a stack used to
 * drop these members before the launch loop and report the remainder as a full success.
 */
export function skipReason(m: Startable): string {
  if (m.depsMissing) return 'dependencies not installed';
  if (m.noStartCmd) return 'no start command configured for this repo';
  return 'cannot start';
}

/** The members worth launching: not already up, and able to come up. */
export function toStart<T extends Startable>(members: T[]): T[] {
  return members.filter((m) => !m.running && m.canStart);
}

/**
 * The members that SHOULD be up and cannot be.
 *
 * Filtering on `canStart` is what makes this correct rather than optimistic: it means
 * "starting this will work", not "a start command exists". The session route used to
 * filter on the latter, so it launched into a worktree with no dependencies, the command
 * died on the spot, and nothing counted it as anything.
 */
export function toSkip<T extends Startable>(members: T[]): SkippedMember[] {
  return members
    .filter((m) => !m.running && !m.canStart)
    .map((m) => ({ repo: m.repo, path: m.path, reason: skipReason(m) }));
}

/**
 * Turn per-repo outcomes into the answer a client keys on.
 *
 * `ok` means what a caller assumes it means: everything that should be up is up. Not
 * `some()` — a stack where two of three failed is not a success. A skipped member fails
 * it too, because skipping is not a no-op: the user asked for the stack, part of it is
 * not running, and there is a reason they can fix. Nothing to start at all IS ok — that
 * is a no-op.
 */
export function report(results: StartOutcome[], skipped: SkippedMember[] = []): StartReport {
  let started = 0;
  const failures: Array<{ repo: string; error?: string }> = [];
  for (const r of results) {
    if (!r.ok) {
      failures.push({ repo: r.repo, error: r.error });
      continue;
    }
    if (r.listening === false) {
      failures.push({ repo: r.repo, error: notListening(r) });
      continue;
    }
    started++;
  }
  return {
    ok: failures.length === 0 && skipped.length === 0,
    started,
    total: results.length + skipped.length,
    skipped,
    failures,
  };
}

/**
 * Spawned but never bound — and the two diagnoses differ completely.
 *
 * A server on an unexpected port is UP and misconfigured: its repo does not read the
 * port env var its concurrency slot sets, which is why a second feature cannot run it.
 * A server on no port at all is simply down. Saying which is the whole value of the
 * message, so it is written once here rather than in each route.
 */
function notListening(r: StartOutcome): string {
  return r.boundElsewhere?.length
    ? `started on port ${r.boundElsewhere.join(', ')} instead of the port this feature's slot expects — this repo does not appear to read its configured port env var, so a second feature cannot run it`
    : 'started but no port was listening — check its log';
}
