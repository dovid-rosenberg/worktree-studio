'use strict';
// The unified state payload — every worktree decorated with its discovered dev
// server and its driving session, grouped into features. One shape serves
// /api/state, every SSE frame, SwiftBar and Alfred, so it is the contract other
// clients build against (docs/api.md).
//
// It is assembled from two halves on purpose. `topology()` is the slow-moving
// shape (repos → worktrees → features) and `sessionState()` is the live
// per-session slice. The SSE stream broadcasts them as two named event types at
// their own rates (server/broadcast.js) — the session half on every Claude hook,
// the topology half only when the shape actually changes. buildState() merges
// them for the callers that want the whole world at once: GET /state, SwiftBar,
// Alfred, resolveGroup.
const { computeFeatures } = require('./features');
const { createRealpathCache } = require('./util');
const sources = require('./sources');

// `repos` and `running` are getters, not values: the repo scan cache and the lsof
// discovery map are replaced wholesale on every refresh, so a captured reference
// would go stale the first time either one is rescanned.
function createState({ cfg, manager, servers, mux, repos, running }) {
  // Both halves compare worktree paths that reach us from three different sources
  // (the git scan, a session's stored paths, lsof), so every comparison resolves
  // symlinks first. One cache serves both halves, swept by topology() — see there.
  const paths = createRealpathCache();

  function baseDirOf(repoPath) {
    return (cfg.baseDirs || []).find((b) => repoPath.startsWith(b)) || '';
  }

  // Repos, their worktrees (decorated with server + session), the features/groups
  // those worktrees roll up into, and the config a client renders its chrome from.
  function topology() {
    const active = running();
    // One pass over the sessions, then a map lookup per worktree — not a scan of
    // every session per worktree.
    const sessionsByPath = manager.sessionIndex(paths.resolve);
    const reposOut = [];
    const flat = [];
    for (const repo of repos()) {
      const wts = [];
      for (const w of repo.worktrees) {
        const dec = servers.decorate({ path: w.path, repo: repo.name }, active);
        const sess = w.isMain ? null : (sessionsByPath.get(paths.resolve(w.path)) || null);
        const wt = {
          repo: repo.name, wtname: w.name, branch: w.branch, path: w.path,
          isMain: w.isMain, detached: w.detached, merged: w.merged,
          baseBranch: repo.defaultBranch, baseDir: baseDirOf(repo.path),
          running: dec.running, pid: dec.pid, ports: dec.ports, canStart: dec.canStart,
          session: sess ? { id: sess.id, state: sess.state, activity: sess.activity, muxName: sess.muxName } : null,
        };
        wts.push(wt);
        flat.push(wt);
      }
      reposOut.push({ name: repo.name, repo: repo.name, path: repo.path, defaultBranch: repo.defaultBranch, worktrees: wts });
    }
    const { features, groups } = computeFeatures(flat, cfg.groups || []);
    // one session per feature: surface the single driving session on the feature,
    // plus its concurrency slot (0,1,2…) when one is allocated — powers the Fleet badge.
    for (const f of [...features, ...groups]) {
      const m = (f.members || []).find((x) => x && x.session);
      f.session = m ? m.session : null;
      if (servers.slots.has(f.name)) f.slot = servers.slots.get(f.name);
    }
    // This pass touches a superset of the paths sessionState() does (its session
    // index resolves every path a session owns, plus every scanned worktree), so
    // it is the one place that can safely decide which cache entries are still
    // live. Anything not seen here is a worktree or a session that is gone.
    paths.sweep();
    return {
      mux: mux ? mux.name : 'none',
      config: { port: cfg.web.port, configFile: cfg._file },
      runningTotal: flat.filter((w) => w.running).length,
      baseDirs: cfg.baseDirs,
      editors: Object.keys(cfg.editors || {}),
      defaultEditor: cfg.defaultEditor,
      webRepos: cfg.webRepos || [],
      runConfigs: cfg.runConfigs || {},
      sources: sources.enabled(cfg),
      repos: reposOut,
      features, groups,
    };
  }

  // The sessions plus, per session, the dev-server state of every repo it owns
  // (its shared workspace) — the half that changes on every Claude hook.
  function sessionState() {
    const active = running();
    const sessions = manager.all();
    const serversById = {};
    for (const s of sessions) {
      const owned = (s.repos || []).filter((r) => r.worktreePath);
      const list = owned.length ? owned : (s.worktreePath ? [{ repo: s.repoName, worktreePath: s.worktreePath }] : []);
      if (list.length) {
        serversById[s.id] = {
          repos: list.map((r) => {
            const hit = active.get(paths.resolve(r.worktreePath));
            return { repo: r.repo, worktreePath: r.worktreePath, running: !!hit, ports: hit ? hit.ports : [], canStart: !!servers.startCfg(r.repo) };
          }),
        };
      }
    }
    return { sessions, servers: serversById };
  }

  // Superset of worktree-dash's contract. Async because every caller awaits it and
  // the halves may need to do I/O later.
  async function buildState() {
    return { ...topology(), ...sessionState() };
  }

  // Resolve a feature/group by name from current state; drop missing members.
  async function resolveGroup(name) {
    const st = await buildState();
    const g = (st.features || []).find((x) => x.name === name) || (st.groups || []).find((x) => x.name === name);
    if (!g) return { group: null, flat: [] };
    const flat = st.repos.flatMap((r) => r.worktrees);
    return { group: { ...g, members: g.members.filter((m) => m && !m.missing) }, flat };
  }

  // running worktrees in the same repo at a different path (must stop to switch) —
  // but a concurrency-slotted repo runs on its own offset ports per feature, so
  // running it in another worktree is NOT a conflict (no stop & switch needed).
  function conflictsFor(member, flat) {
    if (servers.isSlotted(member.repo)) return [];
    return flat.filter((w) => w.repo === member.repo && w.path !== member.path && w.running);
  }

  return { buildState, topology, sessionState, resolveGroup, conflictsFor };
}

module.exports = { createState };
