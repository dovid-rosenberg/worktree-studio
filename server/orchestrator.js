// Feature/group orchestration: the "run the whole stack" verbs the Fleet rail,
// SwiftBar and Alfred drive. A feature is a set of same-named worktrees across
// repos (see features.js); these routes act on all of its members at once —
// start / stop / restart the dev servers, open them in an editor, close or delete
// the feature, and start the one session that drives it.
//
// Two things every verb here has to get right:
//   - concurrency slots: a slot is keyed on the member's OWN feature identity
//     (servers.featureFor → server/identity.js, the same resolver features.js
//     groups with), allocated before any launch and released once the whole stack
//     is down, so a leaked slot never blocks the next feature.
//   - conflicts: another worktree of the same repo already running, which has to be
//     stopped before this one can bind the same ports (unless the repo is slotted).
import * as worktree from './worktree.js';
import { run, shq } from './util.js';

// `app` here is the API router — server.js mounts it at both /api and /api/v1.
function register(app, deps) {
  const { cfg, servers, manager, repos, resolveGroup, conflictsFor, refreshRunning, scheduleBroadcast, rescan } = deps;

  app.post('/group/start', async (req, res) => {
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
    // Key each slot on the member's own feature identity — the one canonical key.
    // Members of a real feature resolve to the same identity → one slot; under the
    // default `basename` strategy a degenerate mixed-name manual group gets a
    // per-worktree slot each (the `manifest` strategy is what fixes that).
    for (const m of toStart) {
      const alloc = servers.allocSlotFor(servers.featureFor(m.path));
      if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    }
    let started = 0; const failures = [];
    await Promise.all(toStart.map(async (m) => {
      const feat = servers.featureFor(m.path);
      const r = await servers.start(m.repo, m.path, servers.launchOpts(m.repo, feat));
      if (r.ok) started++; else failures.push({ repo: m.repo, error: r.error });
    }));
    await refreshRunning();
    scheduleBroadcast();
    // `ok` means what a client keying on it assumes: every member that was going to
    // be started is up. It was hardcoded true, so a stack where all three members
    // failed to bind answered `{ ok: true, started: 0, failures: [3 things] }` and
    // a client that read only `ok` called total failure a success. Nothing to start
    // is still ok — that is a no-op, not a failure.
    res.json({ ok: failures.length === 0, started, total: toStart.length, failures });
  });

  app.post('/group/stop', async (req, res) => {
    const { group } = req.body || {};
    const { group: g } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    await Promise.all(g.members.filter((m) => m.running).map((m) => servers.stop(m.repo, m.path)));
    for (const m of g.members) servers.releaseSlot(servers.featureFor(m.path)); // whole stack stopped → free the feature's slot
    await refreshRunning();
    scheduleBroadcast();
    res.json({ ok: true });
  });

  app.post('/group/restart', async (req, res) => {
    const { group } = req.body || {};
    const { group: g } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const toRestart = g.members.filter((m) => m.running || m.canStart);
    for (const m of toRestart) {
      const alloc = servers.allocSlotFor(servers.featureFor(m.path)); // reuse the feature's slot across the restart
      if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    }
    await Promise.all(toRestart.map((m) => servers.restart(m.repo, m.path, servers.launchOpts(m.repo, servers.featureFor(m.path)))));
    await refreshRunning();
    scheduleBroadcast();
    res.json({ ok: true });
  });

  app.post('/group/open', async (req, res) => {
    const { group, editor } = req.body || {};
    const { group: g } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const ed = (cfg.editors && (cfg.editors[editor] || cfg.editors[cfg.defaultEditor])) || null;
    if (!ed) return res.status(400).json({ error: 'no editor configured' });
    const paths = g.members.map((m) => m.path);
    // split/join, never replace(): the shell-quoted path is the REPLACEMENT string, and
    // `$&`, `` $` ``, `$'` and `$$` in a replacement string are expanded by the engine
    // AFTER shq() has done its quoting — so a worktree path containing `$&` would open
    // some other path entirely, quoting notwithstanding. split/join is literal.
    if (ed.openGroup) { await run('bash', ['-lc', ed.openGroup.split('{paths}').join(paths.map(shq).join(' '))]); }
    else { for (const p of paths) await run('bash', ['-lc', ed.open.split('{path}').join(shq(p))]); }
    res.json({ ok: true });
  });

  // Close a feature: stop its servers + deactivate its sessions (keep worktrees).
  app.post('/group/close', async (req, res) => {
    const { group: g } = await resolveGroup(req.body && req.body.group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    for (const m of g.members) {
      if (m.running) await servers.stop(m.repo, m.path);
      if (m.session) await manager.deactivate(m.session.id);
    }
    for (const m of g.members) servers.releaseSlot(servers.featureFor(m.path)); // whole stack stopped → free the feature's slot
    scheduleBroadcast();
    res.json({ ok: true });
  });

  // Delete a feature: kill its sessions + remove its worktrees (optionally branches).
  app.post('/group/delete', async (req, res) => {
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
    for (const m of g.members) servers.releaseSlot(servers.featureFor(m.path)); // feature removed → free its slot
    await rescan();
    res.json({ ok: results.every((r) => r.ok), results });
  });

  // One session per feature: return the existing one, or start a single session
  // that drives ALL the feature's worktrees (adopt the first, /add-dir the rest).
  app.post('/group/session', async (req, res) => {
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
  });
}

export { register };
