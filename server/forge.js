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
const { run, has, A } = require('./util');

const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };

// gh/glab lookups are cached per worktreePath+branch for ~20s so UI polling doesn't
// hammer the CLIs. Value: { at, data } where data is the per-repo result.
const CI_TTL = 20000;

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
    const r = await run('gh', ['pr', 'view', branch, '--json', 'number,url,state,statusCheckRollup'], { cwd, env });
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const j = JSON.parse(r.stdout);
    return { hasPR: true, provider: 'github', number: j.number, url: j.url, state: j.state, checks: ghChecks(j.statusCheckRollup) };
  },
  async create(branch, cwd, env) {
    const r = await run('gh', ['pr', 'create', '--fill', '--head', branch], { cwd, env });
    if (r.code !== 0) return { ok: false, stderr: r.stderr };
    // gh prints progress lines before the URL — the PR link is the last line.
    return { ok: true, url: r.stdout.trim().split('\n').pop() };
  },
};

const gitlab = {
  id: 'gitlab',
  cli: 'glab',
  async view(branch, cwd, env) {
    const r = await run('glab', ['mr', 'view', branch, '-F', 'json'], { cwd, env });
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const j = JSON.parse(r.stdout);
    const pipe = j.pipeline || j.head_pipeline || {};
    return { hasPR: true, provider: 'gitlab', number: j.iid, url: j.web_url, state: j.state, checks: glChecks(pipe.status) };
  },
  async create(branch, cwd, env) {
    const r = await run('glab', ['mr', 'create', '--fill', '--yes'], { cwd, env });
    if (r.code !== 0) return { ok: false, stderr: r.stderr };
    // glab's output is prose; pull the first URL out of it.
    return { ok: true, url: (r.stdout.match(/https?:\/\/\S+/) || ['created'])[0] };
  },
};

const PROVIDERS = [github, gitlab];

// `providers` / `isInstalled` are injectable so tests can drive the provider contract
// on a machine without gh or glab. CLI presence is probed once, at startup, exactly
// as before — a `has()` per request would shell out on every poll.
function createForge({ manager, resolveGroup, providers = PROVIDERS, isInstalled = (p) => has(p.cli) } = {}) {
  const installed = providers.filter(isInstalled);
  const ciCache = new Map();

  // Look up a single repo's PR/MR + checks (GitHub first, then GitLab). Never
  // throws — returns { repo, hasPR:false } on any miss/failure. Cached per key.
  async function ciForRepo(entry, env) {
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

  // Push the branch, then open a PR/MR with the first provider that accepts it.
  // Reports the LAST provider's stderr on total failure — that's the one that had
  // the final say about why nothing could be opened.
  async function openPullRequest(member, env) {
    await run('git', ['-C', member.path, 'push', '-u', 'origin', member.branch], { env });
    let last = null;
    for (const p of providers) {
      const r = await p.create(member.branch, member.path, env);
      if (r.ok) return { repo: member.repo, url: r.url };
      last = r;
    }
    return { repo: member.repo, error: ((last && last.stderr) || '').trim().split('\n')[0] || 'gh/glab unavailable or failed' };
  }

  // `app` here is the API router — server.js mounts it at both /api and /api/v1.
  function register(app, deps = {}) {
    const mgr = deps.manager || manager;
    const resolve = deps.resolveGroup || resolveGroup;

    app.get('/sessions/:id/ci', A(async (req, res) => {
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
    }));

    // Open a PR (gh) / MR (glab) for each of a feature's branches.
    app.post('/group/pr', A(async (req, res) => {
      const { group: g } = await resolve(req.body && req.body.group);
      if (!g) return res.status(404).json({ error: 'no such feature' });
      const results = [];
      for (const m of g.members) results.push(await openPullRequest(m, ENV));
      res.json({ ok: results.some((r) => r.url), results });
    }));
  }

  return { register, ciForRepo, openPullRequest, installed };
}

module.exports = { createForge, PROVIDERS, github, gitlab, ghChecks, glChecks };
