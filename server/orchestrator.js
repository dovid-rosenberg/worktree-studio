'use strict';
// Feature/group orchestration: the "run the whole stack" verbs the Fleet rail,
// SwiftBar and Alfred drive. A feature is a set of same-named worktrees across
// repos (see features.js); these routes act on all of its members at once —
// start / stop / restart the dev servers, open them in an editor, close or delete
// the feature, and start the one session that drives it.
//
// Two things every verb here has to get right:
//   - concurrency slots: a slot is keyed on the member's OWN feature (its
//     `.worktrees/<name>` basename), allocated before any launch and released once
//     the whole stack is down, so a leaked slot never blocks the next feature.
//   - conflicts: another worktree of the same repo already running, which has to be
//     stopped before this one can bind the same ports (unless the repo is slotted).
const worktree = require('./worktree');
const { featureFromPath } = require('./servers');
const { run, shq, A } = require('./util');

// `app` here is the API router — server.js mounts it at both /api and /api/v1.
function register(app, deps) {
  const { cfg, servers, manager, repos, resolveGroup, conflictsFor, refreshRunning, scheduleBroadcast, rescan } = deps;

  app.post('/group/start', A(async (req, res) => {
    const { group, stopConflicts } = req.body || {};
    const { group: g, flat } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const toStart = g.members.filter((m) => !m.running && m.canStart);
    const conflicts = [];
    const seen = new Set();
    for (const m of toStart) for (const c of conflictsFor(m, flat)) if (!seen.has(c.path)) { seen.add(c.path); conflicts.push(c); }
    if (conflicts.length && !stopConflicts) {
      return res.json({ ok: true, needsConfirm: true, conflicts, willStart: toStart });
    }
    if (stopConflicts) {
      for (const c of conflicts) await servers.stop(c.repo, c.path);
      await new Promise((r) => setTimeout(r, 1200));
    }
    // Key each slot on the member's own feature (its `.worktrees/<name>` basename) — the
    // one canonical key. Members of a real feature share the basename → one slot; a
    // degenerate mixed-name manual group correctly gets a per-worktree slot each.
    for (const m of toStart) {
      const alloc = servers.allocSlotFor(featureFromPath(m.path));
      if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    }
    let started = 0; const failures = [];
    await Promise.all(toStart.map(async (m) => {
      const feat = featureFromPath(m.path);
      const r = await servers.start(m.repo, m.path, servers.launchOpts(m.repo, feat));
      if (r.ok) started++; else failures.push({ repo: m.repo, error: r.error });
    }));
    await refreshRunning();
    scheduleBroadcast();
    res.json({ ok: true, started, total: toStart.length, failures });
  }));

  app.post('/group/stop', A(async (req, res) => {
    const { group } = req.body || {};
    const { group: g } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    await Promise.all(g.members.filter((m) => m.running).map((m) => servers.stop(m.repo, m.path)));
    for (const m of g.members) servers.releaseSlot(featureFromPath(m.path)); // whole stack stopped → free the feature's slot
    await refreshRunning();
    scheduleBroadcast();
    res.json({ ok: true });
  }));

  app.post('/group/restart', A(async (req, res) => {
    const { group } = req.body || {};
    const { group: g } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const toRestart = g.members.filter((m) => m.running || m.canStart);
    for (const m of toRestart) {
      const alloc = servers.allocSlotFor(featureFromPath(m.path)); // reuse the feature's slot across the restart
      if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    }
    await Promise.all(toRestart.map((m) => servers.restart(m.repo, m.path, servers.launchOpts(m.repo, featureFromPath(m.path)))));
    await refreshRunning();
    scheduleBroadcast();
    res.json({ ok: true });
  }));

  app.post('/group/open', A(async (req, res) => {
    const { group, editor } = req.body || {};
    const { group: g } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const ed = (cfg.editors && (cfg.editors[editor] || cfg.editors[cfg.defaultEditor])) || null;
    if (!ed) return res.status(400).json({ error: 'no editor configured' });
    const paths = g.members.map((m) => m.path);
    if (ed.openGroup) { await run('bash', ['-lc', ed.openGroup.replace('{paths}', paths.map(shq).join(' '))]); }
    else { for (const p of paths) await run('bash', ['-lc', ed.open.replace('{path}', shq(p))]); }
    res.json({ ok: true });
  }));

  // Close a feature: stop its servers + deactivate its sessions (keep worktrees).
  app.post('/group/close', A(async (req, res) => {
    const { group: g } = await resolveGroup(req.body && req.body.group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    for (const m of g.members) {
      if (m.running) await servers.stop(m.repo, m.path);
      if (m.session) await manager.deactivate(m.session.id);
    }
    for (const m of g.members) servers.releaseSlot(featureFromPath(m.path)); // whole stack stopped → free the feature's slot
    scheduleBroadcast();
    res.json({ ok: true });
  }));

  // Delete a feature: kill its sessions + remove its worktrees (optionally branches).
  app.post('/group/delete', A(async (req, res) => {
    const { group, deleteBranches } = req.body || {};
    const { group: g } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const results = [];
    for (const m of g.members) {
      const repoObj = repos().find((r) => r.name === m.repo);
      if (!repoObj) { results.push({ repo: m.repo, ok: false, error: 'unknown repo' }); continue; }
      if (m.running) await servers.stop(m.repo, m.path);
      if (m.session) await manager.close(m.session.id);
      const rr = await worktree.remove(repoObj.path, m.path, { branch: m.branch, deleteBranch: deleteBranches });
      results.push({ repo: m.repo, ok: rr.ok, error: rr.error });
    }
    for (const m of g.members) servers.releaseSlot(featureFromPath(m.path)); // feature removed → free its slot
    await rescan();
    res.json({ ok: results.every((r) => r.ok), results });
  }));

  // One session per feature: return the existing one, or start a single session
  // that drives ALL the feature's worktrees (adopt the first, /add-dir the rest).
  app.post('/group/session', A(async (req, res) => {
    const { group: g } = await resolveGroup(req.body && req.body.group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const members = g.members;
    if (!members.length) return res.status(400).json({ error: 'feature has no members' });
    for (const m of members) { const s = manager.sessionForWorktree(m.path); if (s) return res.json({ ok: true, session: s, existed: true }); }
    const [primary, ...rest] = members;
    const pRepo = repos().find((r) => r.name === primary.repo);
    const session = await manager.adopt({ worktreePath: primary.path, repoName: primary.repo, repoPath: pRepo.path, branch: primary.branch, wtname: primary.wtname });
    if (session) {
      for (const m of rest) {
        const ro = repos().find((r) => r.name === m.repo);
        if (ro) await manager.attachRepo(session.id, { repo: m.repo, repoPath: ro.path, worktreePath: m.path, branch: m.branch, wtname: m.wtname });
      }
    }
    scheduleBroadcast();
    res.json({ ok: true, session });
  }));
}

module.exports = { register };
