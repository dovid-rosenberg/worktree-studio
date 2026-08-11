// Everything that talks to a code forge (GitHub via `gh`, GitLab via `glab`):
// reading a branch's PR/MR + CI checks for the serverbar pill, and opening one
// PR/MR per repo for a whole feature.
//
// The two forges are one interface with two implementations, so they're written
// as providers rather than as gh/glab if-else chains. A provider is:
//   { id, cli, view(branch, cwd, env), create(branch, cwd, env), }
//   view   → normalized { hasPR, provider, number, url, state, checks } or null
//   create → { ok:true, url } or { ok:false, stderr }
// Order matters: GitHub is tried first and GitLab is the fallback, which is the
// behavior every caller has always seen.
import { CHILD_ENV, run, has } from './util.ts';
import type { CiChecks, CiRepo, ReviewItem, SessionRepo } from './types.ts';
import type { Router } from 'express';

// The interface above, made checkable — a provider injected by a test is held to
// exactly this and nothing more.

/** A `view()` answer: the wire shape minus the `repo`, which ciForRepo stamps on. */
export type PrView = Omit<CiRepo, 'repo'>;

export interface CreateResult {
  ok: boolean;
  url?: string;
  stderr?: string;
}

export interface Provider {
  id: string;
  cli: string;
  view: (branch: string, cwd: string, env?: NodeJS.ProcessEnv) => Promise<PrView | null>;
  create: (branch: string, cwd: string, env?: NodeJS.ProcessEnv) => Promise<CreateResult>;
  /**
   * Merge requests waiting on YOU to review, in this repo.
   *
   * "@me" is resolved by the CLI from whichever credential it is using, which is the
   * point: Studio never learns or stores who you are on a forge, and a token swapped in
   * `glab auth` changes the answer without changing any config here.
   */
  reviews: (cwd: string, env?: NodeJS.ProcessEnv) => Promise<ReviewItem[]>;
}

const ENV: NodeJS.ProcessEnv = CHILD_ENV;

/**
 * The CLI environment, with a configured token handed to the CLI that wants it.
 *
 * `glab auth login` against a SELF-HOSTED instance now defaults to an OAuth device
 * flow, which needs an application registered on that instance — so the login simply
 * refuses with "Set 'client_id' first" and every MR lookup fails with a message about
 * remotes pointing at no known GitLab host. Nothing in Studio is wrong; there is just
 * no way in.
 *
 * glab reads `GITLAB_TOKEN` in preference to its own stored credentials, and Studio
 * already keeps a token at `sources.gitlab.token` for the intake adapter's REST
 * fallback. Passing that same value through means one credential authenticates both
 * halves, a self-hosted instance needs no OAuth application, and `glab auth login` is
 * not required at all. An existing glab login still wins if no token is configured,
 * because then this adds nothing.
 */
function cliEnv(cfg?: ForgeConfig): NodeJS.ProcessEnv {
  const gl = cfg?.sources?.gitlab;
  if (!gl?.token) return ENV;
  return {
    ...ENV,
    GITLAB_TOKEN: gl.token,
    // glab needs to know which host that token belongs to; without it a self-hosted
    // remote is still "no known GitLab host" however valid the token is.
    ...(gl.host ? { GITLAB_HOST: gl.host.replace(/^https?:\/\//, '').replace(/\/$/, '') } : {}),
  };
}

// gh/glab lookups are cached per worktreePath+branch for ~20s. Nothing polls them
// on the client any more (server/ci.ts pushes instead), but the cache still bounds
// what a burst of triggers plus an on-demand GET /sessions/:id/ci can cost, and it
// is what makes the two paths share one answer. Value: { at, data }.
const CI_TTL = 20000;

// A lookup is a network round-trip through somebody else's CLI, and both of them
// can hang — on a dead VPN, an expired credential helper prompting for input, a
// forge that stopped answering. execFile's `timeout` KILLS the child, which is the
// only thing that actually reclaims the process; a promise-level race would leave
// it wedged forever. A killed lookup exits non-zero and is read as "no PR", which
// is exactly how every other failure already degrades.
const VIEW_TIMEOUT_MS = 20000;

// The same argument, applied to the half that WRITES — which is where it actually
// bites. A lookup that hangs costs a stale pill; a hung `git push` or `gh pr
// create` hangs POST /group/pr itself, and that route loops a feature's members
// SERIALLY, so one wedged member takes the whole feature down with it. A push
// uploads objects, so it gets more room than a pure API call does.
const PUSH_TIMEOUT_MS = 120000;
const CREATE_TIMEOUT_MS = 60000;

// One statusCheckRollup node. CheckRun and StatusContext are two GraphQL types
// spelling the same idea, which is why all three keys are read; the values are
// whatever the CLI's JSON carried, hence the String() coercions below.
interface RollupNode {
  conclusion?: unknown;
  status?: unknown;
  state?: unknown;
}

// Tally a GitHub statusCheckRollup (mixed CheckRun / StatusContext nodes) into
// { passed, running, failed, total }. Neutral/skipped count toward total only.
function ghChecks(rollup: unknown): CiChecks {
  const c: CiChecks = { passed: 0, running: 0, failed: 0, total: 0 };
  const nodes: RollupNode[] = Array.isArray(rollup) ? rollup : [];
  for (const n of nodes) {
    c.total++;
    const conclusion = String(n.conclusion || '').toUpperCase();
    const status = String(n.status || n.state || '').toUpperCase();
    if (conclusion === 'SUCCESS' || status === 'SUCCESS') c.passed++;
    else if (
      ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(
        conclusion,
      ) ||
      status === 'FAILURE' ||
      status === 'ERROR'
    )
      c.failed++;
    else if (['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED'].includes(status))
      c.running++;
  }
  return c;
}

// Map a single GitLab pipeline status into the same { passed, running, failed, total } shape.
function glChecks(status: unknown): CiChecks {
  const s = String(status || '').toLowerCase();
  if (!s) return { passed: 0, running: 0, failed: 0, total: 0 };
  if (s === 'success') return { passed: 1, running: 0, failed: 0, total: 1 };
  if (['failed', 'canceled', 'cancelled'].includes(s)) return { passed: 0, running: 0, failed: 1, total: 1 };
  if (['running', 'pending', 'created', 'preparing', 'scheduled', 'waiting_for_resource'].includes(s))
    return { passed: 0, running: 1, failed: 0, total: 1 };
  return { passed: 0, running: 0, failed: 0, total: 0 };
}

// The slices of each CLI's JSON that are read below. Every field is optional
// because the shape belongs to somebody else: a key that moves becomes a missing
// value here rather than a parse that lied about what it got.
interface GhPr {
  number?: number;
  url?: string;
  state?: string;
  statusCheckRollup?: unknown;
  /** GitHub's own readiness verdict, across two fields. */
  mergeStateStatus?: string;
  reviewDecision?: string;
  isDraft?: boolean;
}

interface GlPipeline {
  status?: string;
}

interface GlMr {
  iid?: number;
  web_url?: string;
  state?: string;
  pipeline?: GlPipeline | null;
  head_pipeline?: GlPipeline | null;
  /** GitLab's own readiness verdict — already in the JSON this call fetches. */
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  draft?: boolean;
  work_in_progress?: boolean;
}

/**
 * GitLab's `detailed_merge_status`, reduced to the handful of answers worth acting on.
 *
 * It has a couple of dozen values and most of them mean "not yet, and you cannot do
 * anything about it from here". These are the ones that name something YOU would do next.
 */
function glBlocked(status: string | undefined, conflicts: boolean | undefined): string {
  if (conflicts) return 'conflicts';
  switch (status) {
    case 'mergeable':
      return '';
    case 'broken_status':
    case 'conflict':
      return 'conflicts';
    case 'need_rebase':
      return 'needs-rebase';
    case 'not_approved':
      return 'not-approved';
    case 'draft_status':
      return 'draft';
    case 'ci_must_pass':
    case 'ci_still_running':
      return 'checks';
    // Everything else — discussions open, jira, blocked by another MR — is real but not
    // something this bar can usefully name, so it reports "not mergeable" and no reason.
    default:
      return status ? 'other' : '';
  }
}

/** GitHub says the same things across two fields. */
function ghBlocked(mergeState: string | undefined, review: string | undefined): string {
  switch (mergeState) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      break;
    case 'DIRTY':
      return 'conflicts';
    case 'BEHIND':
      return 'needs-rebase';
    case 'BLOCKED':
      return review === 'APPROVED' ? 'checks' : 'not-approved';
    case 'DRAFT':
      return 'draft';
    case 'UNSTABLE':
      return 'checks';
    default:
      break;
  }
  return review && review !== 'APPROVED' ? 'not-approved' : '';
}

const github: Provider = {
  id: 'github',
  cli: 'gh',
  async view(branch, cwd, env) {
    const r = await run(
      'gh',
      ['pr', 'view', branch, '--json',
       'number,url,state,statusCheckRollup,mergeStateStatus,reviewDecision,isDraft'],
      {
        cwd,
        env,
        timeout: VIEW_TIMEOUT_MS,
      },
    );
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const j: GhPr = JSON.parse(r.stdout);
    const blockedBy = j.isDraft ? 'draft' : ghBlocked(j.mergeStateStatus, j.reviewDecision);
    return {
      hasPR: true,
      provider: 'github',
      number: j.number,
      url: j.url,
      state: j.state,
      checks: ghChecks(j.statusCheckRollup),
      mergeable: j.mergeStateStatus ? !blockedBy : null,
      blockedBy,
    };
  },
  async reviews(cwd, env) {
    const r = await run(
      'gh',
      ['pr', 'list', '--search', 'review-requested:@me', '--state', 'open', '--limit', '50',
       '--json', 'number,title,url,author,isDraft,headRefName,baseRefName,updatedAt'],
      { cwd, env, timeout: VIEW_TIMEOUT_MS },
    );
    if (r.code !== 0 || !r.stdout.trim()) return [];
    const rows = JSON.parse(r.stdout) as Array<{
      number: number; title: string; url: string; isDraft?: boolean;
      author?: { login?: string }; headRefName?: string; baseRefName?: string; updatedAt?: string;
    }>;
    return rows.map((j) => ({
      provider: 'github',
      repo: '',
      number: j.number,
      title: j.title || '',
      url: j.url || '',
      author: j.author?.login || '',
      draft: !!j.isDraft,
      branch: j.headRefName || '',
      target: j.baseRefName || '',
      updatedAt: j.updatedAt || '',
    }));
  },
  async create(branch, cwd, env) {
    const r = await run('gh', ['pr', 'create', '--fill', '--head', branch], {
      cwd,
      env,
      timeout: CREATE_TIMEOUT_MS,
    });
    if (r.code !== 0) return { ok: false, stderr: r.stderr };
    // gh prints progress lines before the URL — the PR link is the last line.
    return { ok: true, url: r.stdout.trim().split('\n').pop() };
  },
};

const gitlab: Provider = {
  id: 'gitlab',
  cli: 'glab',
  async view(branch, cwd, env) {
    const r = await run('glab', ['mr', 'view', branch, '-F', 'json'], { cwd, env, timeout: VIEW_TIMEOUT_MS });
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const j: GlMr = JSON.parse(r.stdout);
    const pipe: GlPipeline = j.pipeline || j.head_pipeline || {};
    const draft = !!(j.draft || j.work_in_progress);
    const blockedBy = draft ? 'draft' : glBlocked(j.detailed_merge_status, j.has_conflicts);
    return {
      hasPR: true,
      provider: 'gitlab',
      number: j.iid,
      url: j.web_url,
      state: j.state,
      checks: glChecks(pipe.status),
      // Null, not false, when the forge did not say: "we do not know" and "no" lead to
      // different sentences, and only one of them is worth acting on.
      mergeable: j.detailed_merge_status ? !blockedBy : null,
      blockedBy,
    };
  },
  async reviews(cwd, env) {
    const r = await run('glab', ['mr', 'list', '--reviewer=@me', '-F', 'json'], {
      cwd,
      env,
      timeout: VIEW_TIMEOUT_MS,
    });
    if (r.code !== 0 || !r.stdout.trim()) return [];
    const rows = JSON.parse(r.stdout) as Array<{
      iid: number; title?: string; web_url?: string; draft?: boolean; work_in_progress?: boolean;
      source_branch?: string; target_branch?: string; updated_at?: string;
      author?: { username?: string };
    }>;
    return rows.map((j) => ({
      provider: 'gitlab',
      repo: '',
      number: j.iid,
      title: j.title || '',
      url: j.web_url || '',
      author: j.author?.username || '',
      // Older GitLab spells it `work_in_progress`; both mean the same thing and a draft
      // shown as ready is the one mistake worth avoiding here.
      draft: !!(j.draft || j.work_in_progress),
      branch: j.source_branch || '',
      target: j.target_branch || '',
      updatedAt: j.updated_at || '',
    }));
  },
  async create(_branch, cwd, env) {
    const r = await run('glab', ['mr', 'create', '--fill', '--yes'], {
      cwd,
      env,
      timeout: CREATE_TIMEOUT_MS,
    });
    if (r.code !== 0) return { ok: false, stderr: r.stderr };
    // glab's output is prose; pull the first URL out of it.
    return { ok: true, url: (r.stdout.match(/https?:\/\/\S+/) || ['created'])[0] };
  },
};

const PROVIDERS: Provider[] = [github, gitlab];

/**
 * A feature member as the PR path uses it — the three fields this file reads,
 * rather than `Worktree` (server/types.ts), because what gets a PR opened for it
 * is whatever the injected `resolveGroup` hands back.
 */
export interface PrMember {
  repo: string;
  path: string;
  /**
   * Null on a DETACHED worktree, which is a real row in a resolved feature —
   * `Worktree.branch` is `string | null` for exactly that case. openPullRequest()
   * refuses those rather than letting a null reach a git argv.
   */
  branch: string | null;
}

/**
 * What a push is read out of. A `RunResult` satisfies it, and a double standing
 * in for `pushBranch` owes nothing beyond the fields read below.
 */
export interface PushResult {
  code: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

/** One member's outcome from POST /group/pr: a URL when it opened, else a reason. */
export interface PrResult {
  repo: string;
  url?: string;
  error?: string;
}

// Push a member's branch to origin. Split out (and injectable via createForge) so
// the push half of openPullRequest can be driven without a remote.
function pushBranchToOrigin(
  member: PrMember,
  env?: NodeJS.ProcessEnv,
  timeoutMs = PUSH_TIMEOUT_MS,
): Promise<PushResult> {
  // openPullRequest() refuses a detached member before it gets here, but this is
  // exported and injectable, so it does not lean on its one caller: a null branch is
  // a failed push, not a TypeError out of execFile's argv check.
  if (!member.branch)
    return Promise.resolve({ code: 1, stdout: '', stderr: 'no branch — the worktree is detached' });
  return run('git', ['-C', member.path, 'push', '-u', 'origin', member.branch], { env, timeout: timeoutMs });
}

// The one line of a failed `git push` worth showing. git interleaves progress
// ("To github.com:acme/api.git") with the actual complaint, and the complaint is
// rarely first — so pick the first line that IS one, rather than blindly taking
// line 1 and showing the user a remote URL as an error message.
function pushFailureLine(r: PushResult): string {
  // A child killed on its timeout exits with no code and usually says nothing at
  // all, so the generic fallback below would report "git push exited 1" for the one
  // failure the user can actually do something about.
  if (r.timedOut) return 'git push timed out — no answer from origin';
  const lines = `${r.stderr || ''}\n${r.stdout || ''}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    lines.find((l) => /^(?:error|fatal|remote)\b/i.test(l) || l.startsWith('!')) ||
    lines[0] ||
    `git push exited ${r.code}`
  );
}

/**
 * What a lookup needs of a session's repo. `SessionRepo` satisfies it; its two
 * worktree fields stay null until promote(), which is the miss ciForRepo's first
 * guard answers.
 */
export interface CiEntry {
  repo: string;
  worktreePath?: string | null;
  branch?: string | null;
}

/** The SessionManager, typed by the one method the routes below call. */
interface SessionLookup {
  get: (id: string) => { repos?: SessionRepo[] } | undefined;
}

/** `resolveGroup` (server/state.ts), typed by what POST /group/pr reads of it. */
type ResolveGroup = (name: string) => Promise<{ group?: { members: PrMember[] } | null }>;

/** The one slice of config forge reads: where GitLab is and how to authenticate to it. */
interface ForgeConfig {
  sources?: { gitlab?: { host?: string; token?: string } };
}

interface ForgeDeps {
  /** Read for `sources.gitlab.token` — see cliEnv(). */
  cfg?: ForgeConfig;
  /** the SessionManager, typed by the one method the routes below call */
  manager?: SessionLookup;
  resolveGroup?: ResolveGroup;
  providers?: Provider[];
  isInstalled?: (p: Provider) => boolean;
  pushBranch?: (member: PrMember, env?: NodeJS.ProcessEnv, timeoutMs?: number) => Promise<PushResult>;
  onChanged?: () => void;
}

/** One provider's refusal, plus whether it was ever in a position to answer. */
interface CreateFailure {
  installed: boolean;
  stderr: string;
}

// `providers` / `isInstalled` are injectable so tests can drive the provider contract
// on a machine without gh or glab. CLI presence is probed once, at startup, exactly
// as before — a `has()` per request would shell out on every poll.
// `onChanged` is how the push side (server/ci.ts) hears that *this* module just did
// something that changes a branch's PR state — opening one. Everything else that can
// (a commit, a push, a branch switch) is observed by the git watcher instead.
function createForge({
  manager,
  resolveGroup,
  cfg,
  providers = PROVIDERS,
  isInstalled = (p) => has(p.cli),
  pushBranch = pushBranchToOrigin,
  onChanged = () => {},
}: ForgeDeps = {}) {
  // Resolved once: the token cannot change without a restart, since config is read at boot.
  const forgeEnv = cliEnv(cfg);
  const installed = providers.filter(isInstalled);
  const installedSet = new Set(installed); // membership test for failure attribution
  const ciCache = new Map<string, { at: number; data: CiRepo }>();

  // Drop every cached answer. Called when something is known to have changed the
  // truth (a new commit, a push, a PR just opened) — without it a refresh triggered
  // inside the TTL would re-serve the very answer it was triggered to replace.
  function invalidate() {
    ciCache.clear();
  }

  // Look up a single repo's PR/MR + checks (GitHub first, then GitLab). Never
  // throws — returns { repo, hasPR:false } on any miss/failure. Cached per key.
  async function ciForRepo(entry: CiEntry, env: NodeJS.ProcessEnv = forgeEnv): Promise<CiRepo> {
    const { repo, worktreePath, branch } = entry;
    if (!worktreePath || !branch) return { repo, hasPR: false };
    const key = `${worktreePath}\n${branch}`;
    const hit = ciCache.get(key);
    if (hit && Date.now() - hit.at < CI_TTL) return { ...hit.data, repo };
    let data: CiRepo = { repo, hasPR: false };
    try {
      for (const p of installed) {
        const found = await p.view(branch, worktreePath, env);
        if (found) {
          data = { repo, ...found };
          break;
        }
      }
    } catch {
      data = { repo, hasPR: false };
    }
    ciCache.set(key, { at: Date.now(), data });
    return { ...data, repo };
  }

  // Which of several failures to report when nothing could be opened.
  //
  // Reporting the LAST provider's stderr was wrong because "didn't run" and
  // "ran and refused" are not the same failure. On a GitHub-only repo `gh pr
  // create` fails with a real reason, then `glab` isn't installed, its spawn
  // fails with ENOENT and its stderr is empty — so the empty string overwrote
  // gh's reason and the user got a generic "gh/glab unavailable or failed".
  //
  // The failure that matters is the first one from a provider that is actually
  // installed (GitHub first, matching the try order — that is the forge the
  // repo is on). Only when no installed provider had anything to say do we fall
  // back, and a machine with no forge CLI at all gets told exactly that instead
  // of a sentence implying its CLI refused.
  function failureReason(failures: CreateFailure[]): string {
    const ran = failures.find((f) => f.installed && f.stderr);
    if (ran) return ran.stderr;
    if (failures.some((f) => f.installed)) return 'gh/glab unavailable or failed';
    const said = failures.find((f) => f.stderr);
    if (said) return said.stderr;
    return 'no forge CLI installed — install gh (GitHub) or glab (GitLab)';
  }

  // Push the branch, then open a PR/MR with the first provider that accepts it.
  async function openPullRequest(member: PrMember, env: NodeJS.ProcessEnv = forgeEnv): Promise<PrResult> {
    // A detached worktree has no branch to push or open a PR from. Without this the
    // null rode into `git push -u origin <branch>`, and execFile rejects a non-string
    // argv entry with a TypeError — a 500 out of the route, and (because /group/pr
    // loops members serially) one that takes every later member of the feature with
    // it. Report it as this member's own failure, which is the shape the loop expects.
    if (!member.branch) return { repo: member.repo, error: 'no branch — the worktree is detached' };
    // The push result used to be discarded. It can't be: a rejected push (no
    // `origin`, no upstream, non-fast-forward) means the branch the PR would be
    // opened from is not on the forge, so `gh pr create` fails too — with a
    // downstream symptom ("No commits between…") that hides the real cause.
    // Stop here and report what git actually said.
    const pushed = await pushBranch(member, env);
    if (pushed.code !== 0) return { repo: member.repo, error: `git push failed: ${pushFailureLine(pushed)}` };
    // Creation is attempted for every provider, installed or not (a missing CLI
    // simply fails and the next one gets its turn) — but whether it was installed
    // is what decides whose failure is worth reporting.
    const failures: CreateFailure[] = [];
    for (const p of providers) {
      const r = await p.create(member.branch, member.path, env);
      if (r.ok) return { repo: member.repo, url: r.url };
      failures.push({ installed: installedSet.has(p), stderr: (r.stderr || '').trim().split('\n')[0] });
    }
    return { repo: member.repo, error: failureReason(failures) };
  }

  // `app` here is the API router — server.ts mounts it at both /api and /api/v1.
  function register(app: Router, deps: Pick<ForgeDeps, 'manager' | 'resolveGroup'> = {}) {
    // Each route needs its collaborator, and the one createForge() call that has
    // them is the same one whose register() mounts the routes — so a route reached
    // without one is a wiring bug, and it stays as loud as it has always been
    // rather than being softened into a 404 that would read as "no such session".
    const mgr = (deps.manager || manager)!;
    const resolve = (deps.resolveGroup || resolveGroup)!;

    app.get('/sessions/:id/ci', async (req, res) => {
      const s = mgr.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'no such session' });
      const entries = (s.repos || []).filter((r) => r.worktreePath && r.branch);
      // No forge CLI installed → answer instantly without shelling out.
      if (!installed.length) return res.json({ repos: entries.map((r) => ({ repo: r.repo, hasPR: false })) });
      // Per-repo lookups are independent (and each is cached + never throws) — run them
      // in parallel so a multi-repo feature isn't gated on serial gh/glab round-trips.
      const repos = await Promise.all(
        entries.map(async (entry) => {
          try {
            return await ciForRepo(entry, forgeEnv);
          } catch {
            return { repo: entry.repo, hasPR: false };
          }
        }),
      );
      res.json({ repos });
    });

    // Open a PR (gh) / MR (glab) for each of a feature's branches.
    app.post('/group/pr', async (req, res) => {
      // String(x ?? ''): the body can carry an array, an object, a number. Every other
      // resolveGroup call site coerces — orchestrator.ts documents it as the resolver's
      // contract — and this was the one that did not.
      const { group: g } = await resolve(String(req.body?.group ?? ''));
      if (!g) return res.status(404).json({ error: 'no such feature' });
      const results: PrResult[] = [];
      for (const m of g.members) results.push(await openPullRequest(m, forgeEnv));
      // A branch that had no PR a second ago now has one, and its cached "hasPR:
      // false" says otherwise. Drop it and tell the push side to re-look, so the
      // pill appears without waiting out the TTL.
      if (results.some((r) => r.url)) {
        invalidate();
        try {
          onChanged();
        } catch {
          /* the feed must never break the route */
        }
      }
      /*
       * Every branch got a PR, not "at least one did".
       *
       * `some()` meant a two-repo feature whose FE PR opened and whose BE push was
       * rejected — no upstream, non-fast-forward — answered ok:true, and the toast said
       * the feature had a PR. Every other group verb settled on "no failures" for the
       * same reason.
       */
      res.json({ ok: results.every((r) => !!r.url), results });
    });
  }

  /**
   * Merge requests awaiting your review in one checkout.
   *
   * Tries every INSTALLED provider and returns the first that answers, because a checkout
   * is on one forge and asking the other costs a spawn for a guaranteed miss. Null — not
   * an empty array — when nobody could answer at all: "no gh or glab" and "nothing is
   * waiting" are different facts, and only the first is worth retrying slowly.
   */
  async function reviewsFor(repoPath: string): Promise<ReviewItem[] | null> {
    const env = cliEnv(cfg);
    let answered = false;
    const out: ReviewItem[] = [];
    for (const p of installed) {
      try {
        const rows = await p.reviews(repoPath, env);
        // A provider that errors returns [] and is indistinguishable from an empty queue,
        // which is the honest limit of what the CLIs tell us — so "answered" means the
        // call completed, and a repo on the other forge simply contributes nothing.
        answered = true;
        out.push(...rows);
      } catch {
        /* try the next provider */
      }
    }
    return answered ? out : null;
  }

  return { register, ciForRepo, reviewsFor, openPullRequest, invalidate, installed };
}

const TIMEOUTS = { VIEW_TIMEOUT_MS, PUSH_TIMEOUT_MS, CREATE_TIMEOUT_MS };

export {
  createForge,
  PROVIDERS,
  github,
  gitlab,
  ghChecks,
  glChecks,
  pushFailureLine,
  pushBranchToOrigin,
  TIMEOUTS,
};
