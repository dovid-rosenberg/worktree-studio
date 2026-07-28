'use strict';
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
const { run, has } = require('./util');

const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };

// gh/glab lookups are cached per worktreePath+branch for ~20s. Nothing polls them
// on the client any more (server/ci.js pushes instead), but the cache still bounds
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

// Tally a GitHub statusCheckRollup (mixed CheckRun / StatusContext nodes) into
// { passed, running, failed, total }. Neutral/skipped count toward total only.
function ghChecks(rollup) {
  const c = { passed: 0, running: 0, failed: 0, total: 0 };
  for (const n of (Array.isArray(rollup) ? rollup : [])) {
    c.total++;
    const conclusion = String(n.conclusion || '').toUpperCase();
    const status = String(n.status || n.state || '').toUpperCase();
    if (conclusion === 'SUCCESS' || status === 'SUCCESS') c.passed++;
    else if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(conclusion) || status === 'FAILURE' || status === 'ERROR') c.failed++;
    else if (['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED'].includes(status)) c.running++;
  }
  return c;
}

// Map a single GitLab pipeline status into the same { passed, running, failed, total } shape.
function glChecks(status) {
  const s = String(status || '').toLowerCase();
  if (!s) return { passed: 0, running: 0, failed: 0, total: 0 };
  if (s === 'success') return { passed: 1, running: 0, failed: 0, total: 1 };
  if (['failed', 'canceled', 'cancelled'].includes(s)) return { passed: 0, running: 0, failed: 1, total: 1 };
  if (['running', 'pending', 'created', 'preparing', 'scheduled', 'waiting_for_resource'].includes(s)) return { passed: 0, running: 1, failed: 0, total: 1 };
  return { passed: 0, running: 0, failed: 0, total: 0 };
}

const github = {
  id: 'github',
  cli: 'gh',
  async view(branch, cwd, env) {
    const r = await run('gh', ['pr', 'view', branch, '--json', 'number,url,state,statusCheckRollup'], { cwd, env, timeout: VIEW_TIMEOUT_MS });
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const j = JSON.parse(r.stdout);
    return { hasPR: true, provider: 'github', number: j.number, url: j.url, state: j.state, checks: ghChecks(j.statusCheckRollup) };
  },
  async create(branch, cwd, env) {
    const r = await run('gh', ['pr', 'create', '--fill', '--head', branch], { cwd, env, timeout: CREATE_TIMEOUT_MS });
    if (r.code !== 0) return { ok: false, stderr: r.stderr };
    // gh prints progress lines before the URL — the PR link is the last line.
    return { ok: true, url: r.stdout.trim().split('\n').pop() };
  },
};

const gitlab = {
  id: 'gitlab',
  cli: 'glab',
  async view(branch, cwd, env) {
    const r = await run('glab', ['mr', 'view', branch, '-F', 'json'], { cwd, env, timeout: VIEW_TIMEOUT_MS });
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const j = JSON.parse(r.stdout);
    const pipe = j.pipeline || j.head_pipeline || {};
    return { hasPR: true, provider: 'gitlab', number: j.iid, url: j.web_url, state: j.state, checks: glChecks(pipe.status) };
  },
  async create(branch, cwd, env) {
    const r = await run('glab', ['mr', 'create', '--fill', '--yes'], { cwd, env, timeout: CREATE_TIMEOUT_MS });
    if (r.code !== 0) return { ok: false, stderr: r.stderr };
    // glab's output is prose; pull the first URL out of it.
    return { ok: true, url: (r.stdout.match(/https?:\/\/\S+/) || ['created'])[0] };
  },
};

const PROVIDERS = [github, gitlab];

// Push a member's branch to origin. Split out (and injectable via createForge) so
// the push half of openPullRequest can be driven without a remote.
function pushBranchToOrigin(member, env, timeoutMs = PUSH_TIMEOUT_MS) {
  return run('git', ['-C', member.path, 'push', '-u', 'origin', member.branch], { env, timeout: timeoutMs });
}

// The one line of a failed `git push` worth showing. git interleaves progress
// ("To github.com:acme/api.git") with the actual complaint, and the complaint is
// rarely first — so pick the first line that IS one, rather than blindly taking
// line 1 and showing the user a remote URL as an error message.
function pushFailureLine(r) {
  // A child killed on its timeout exits with no code and usually says nothing at
  // all, so the generic fallback below would report "git push exited 1" for the one
  // failure the user can actually do something about.
  if (r.timedOut) return 'git push timed out — no answer from origin';
  const lines = `${r.stderr || ''}\n${r.stdout || ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(?:error|fatal|remote)\b/i.test(l) || l.startsWith('!')) || lines[0] || `git push exited ${r.code}`;
}

// `providers` / `isInstalled` are injectable so tests can drive the provider contract
// on a machine without gh or glab. CLI presence is probed once, at startup, exactly
// as before — a `has()` per request would shell out on every poll.
// `onChanged` is how the push side (server/ci.js) hears that *this* module just did
// something that changes a branch's PR state — opening one. Everything else that can
// (a commit, a push, a branch switch) is observed by the git watcher instead.
/**
 * @param {object} [deps]
 * @param {InstanceType<typeof import('./sessions').SessionManager>} [deps.manager]
 * @param {(name: string) => Promise<{ group?: any }>} [deps.resolveGroup]
 * @param {typeof PROVIDERS} [deps.providers]
 * @param {(p: any) => boolean} [deps.isInstalled]
 * @param {typeof pushBranchToOrigin} [deps.pushBranch]
 * @param {() => void} [deps.onChanged]
 */
function createForge({ manager, resolveGroup, providers = PROVIDERS, isInstalled = (p) => has(p.cli), pushBranch = pushBranchToOrigin, onChanged = () => {} } = {}) {
  const installed = providers.filter(isInstalled);
  const installedSet = new Set(installed); // membership test for failure attribution
  const ciCache = new Map();

  // Drop every cached answer. Called when something is known to have changed the
  // truth (a new commit, a push, a PR just opened) — without it a refresh triggered
  // inside the TTL would re-serve the very answer it was triggered to replace.
  function invalidate() { ciCache.clear(); }

  // Look up a single repo's PR/MR + checks (GitHub first, then GitLab). Never
  // throws — returns { repo, hasPR:false } on any miss/failure. Cached per key.
  async function ciForRepo(entry, env = ENV) {
    const { repo, worktreePath, branch } = entry;
    if (!worktreePath || !branch) return { repo, hasPR: false };
    const key = `${worktreePath}\n${branch}`;
    const hit = ciCache.get(key);
    if (hit && Date.now() - hit.at < CI_TTL) return { ...hit.data, repo };
    let data = { repo, hasPR: false };
    try {
      for (const p of installed) {
        const found = await p.view(branch, worktreePath, env);
        if (found) { data = { repo, ...found }; break; }
      }
    } catch { data = { repo, hasPR: false }; }
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
  function failureReason(failures) {
    const ran = failures.find((f) => f.installed && f.stderr);
    if (ran) return ran.stderr;
    if (failures.some((f) => f.installed)) return 'gh/glab unavailable or failed';
    const said = failures.find((f) => f.stderr);
    if (said) return said.stderr;
    return 'no forge CLI installed — install gh (GitHub) or glab (GitLab)';
  }

  // Push the branch, then open a PR/MR with the first provider that accepts it.
  async function openPullRequest(member, env) {
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
    const failures = [];
    for (const p of providers) {
      const r = await p.create(member.branch, member.path, env);
      if (r.ok) return { repo: member.repo, url: r.url };
      failures.push({ installed: installedSet.has(p), stderr: (r.stderr || '').trim().split('\n')[0] });
    }
    return { repo: member.repo, error: failureReason(failures) };
  }

  // `app` here is the API router — server.js mounts it at both /api and /api/v1.
  /**
   * @param {import('express').Router} app
   * @param {{ manager?: InstanceType<typeof import('./sessions').SessionManager>, resolveGroup?: (name: string) => Promise<{ group?: any }> }} [deps]
   */
  function register(app, deps = {}) {
    const mgr = deps.manager || manager;
    const resolve = deps.resolveGroup || resolveGroup;

    app.get('/sessions/:id/ci', async (req, res) => {
      const s = mgr.get(req.params.id);
      if (!s) return res.status(404).json({ error: 'no such session' });
      const entries = (s.repos || []).filter((r) => r.worktreePath && r.branch);
      // No forge CLI installed → answer instantly without shelling out.
      if (!installed.length) return res.json({ repos: entries.map((r) => ({ repo: r.repo, hasPR: false })) });
      // Per-repo lookups are independent (and each is cached + never throws) — run them
      // in parallel so a multi-repo feature isn't gated on serial gh/glab round-trips.
      const repos = await Promise.all(entries.map(async (entry) => {
        try { return await ciForRepo(entry, ENV); }
        catch { return { repo: entry.repo, hasPR: false }; }
      }));
      res.json({ repos });
    });

    // Open a PR (gh) / MR (glab) for each of a feature's branches.
    app.post('/group/pr', async (req, res) => {
      const { group: g } = await resolve(req.body && req.body.group);
      if (!g) return res.status(404).json({ error: 'no such feature' });
      const results = [];
      for (const m of g.members) results.push(await openPullRequest(m, ENV));
      // A branch that had no PR a second ago now has one, and its cached "hasPR:
      // false" says otherwise. Drop it and tell the push side to re-look, so the
      // pill appears without waiting out the TTL.
      if (results.some((r) => r.url)) { invalidate(); try { onChanged(); } catch { /* the feed must never break the route */ } }
      res.json({ ok: results.some((r) => r.url), results });
    });
  }

  return { register, ciForRepo, openPullRequest, invalidate, installed };
}

module.exports = {
  createForge, PROVIDERS, github, gitlab, ghChecks, glChecks, pushFailureLine, pushBranchToOrigin,
  TIMEOUTS: { VIEW_TIMEOUT_MS, PUSH_TIMEOUT_MS, CREATE_TIMEOUT_MS },
};
