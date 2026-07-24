'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const configMod = require('./config');
const muxSelect = require('./multiplexer');
const gitMod = require('./git');
const worktree = require('./worktree');
const review = require('./review');
const sources = require('./sources');
const { SessionManager } = require('./sessions');
const { Servers, featureFromPath } = require('./servers');
const { computeFeatures } = require('./features');
const { run, has, shq } = require('./util');

// Wrap async route handlers so a rejected promise becomes a 500 instead of an
// unhandled rejection (Express 4 doesn't await handlers).
const A = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[wt-studio]', e);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

async function main() {
  const cfg = configMod.load();
  const mux = await muxSelect.select();
  if (!mux) {
    console.error('[wt-studio] tmux not found — install it (brew install tmux) and retry.');
  } else {
    console.log(`[wt-studio] multiplexer: ${mux.name}`);
  }

  const manager = new SessionManager(cfg, mux || require('./multiplexer/tmux'));
  const servers = new Servers(cfg);

  // ---- repo scan cache ----
  let repos = [];
  let scanning = false;
  async function rescan() {
    if (scanning) return;
    scanning = true;
    try { repos = await gitMod.scan(cfg.baseDirs, cfg.scanDepth); } catch (e) { /* */ }
    scanning = false;
    scheduleBroadcast();
  }

  function baseDirOf(repoPath) {
    return (cfg.baseDirs || []).find((b) => repoPath.startsWith(b)) || '';
  }

  // Cached lsof discovery — refreshed on a timer and after mutations, not on
  // every SSE broadcast (which fires per Claude hook → per tool call).
  let runningCache = new Map();
  async function refreshRunning() {
    try { runningCache = await servers.discoverRunning(); } catch { /* */ }
  }

  // Unified state: every worktree decorated with discovered server state + its
  // session (if any), grouped into features. Superset of worktree-dash's contract.
  async function buildState() {
    const running = runningCache;
    const sessions = manager.all();
    const reposOut = [];
    const flat = [];
    for (const repo of repos) {
      const wts = [];
      for (const w of repo.worktrees) {
        const dec = servers.decorate({ path: w.path, repo: repo.name }, running);
        const sess = w.isMain ? null : manager.sessionForWorktree(w.path);
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
    // per-session server state — every repo the session owns (its shared workspace)
    const { realpath } = require('./servers');
    const serversById = {};
    for (const s of sessions) {
      const owned = (s.repos || []).filter((r) => r.worktreePath);
      const list = owned.length ? owned : (s.worktreePath ? [{ repo: s.repoName, worktreePath: s.worktreePath }] : []);
      if (list.length) {
        serversById[s.id] = {
          repos: list.map((r) => {
            const hit = running.get(realpath(r.worktreePath));
            return { repo: r.repo, worktreePath: r.worktreePath, running: !!hit, ports: hit ? hit.ports : [], canStart: !!servers.startCfg(r.repo) };
          }),
        };
      }
    }
    return {
      mux: mux ? mux.name : 'none',
      config: { port: cfg.web.port, configFile: cfg._file },
      runningTotal: flat.filter((w) => w.running).length,
      baseDirs: cfg.baseDirs,
      editors: Object.keys(cfg.editors || {}),
      defaultEditor: cfg.defaultEditor,
      runConfigs: cfg.runConfigs || {},
      sources: sources.enabled(cfg),
      repos: reposOut,
      features, groups,
      sessions,
      servers: serversById,
    };
  }

  // Resolve a feature/group by name from current state; drop missing members.
  async function resolveGroup(name) {
    const st = await buildState();
    const g = (st.features || []).find((x) => x.name === name) || (st.groups || []).find((x) => x.name === name);
    if (!g) return { group: null, flat: [] };
    const flat = st.repos.flatMap((r) => r.worktrees);
    return { group: { ...g, members: g.members.filter((m) => m && !m.missing) }, flat };
  }

  // running worktrees in the same repo at a different path (must stop to switch)
  function conflictsFor(member, flat) {
    return flat.filter((w) => w.repo === member.repo && w.path !== member.path && w.running);
  }

  // ---- SSE live state ----
  const sseClients = new Set();
  let broadcastTimer = null;
  function scheduleBroadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(async () => {
      broadcastTimer = null;
      const state = await buildState();
      const payload = `data: ${JSON.stringify(state)}\n\n`;
      for (const res of sseClients) { try { res.write(payload); } catch { /* */ } }
    }, 80);
  }
  manager.on('change', scheduleBroadcast);

  // ---- express ----
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use(express.text({ type: 'text/*', limit: '8mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/state', A(async (req, res) => res.json(await buildState())));

  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(':ok\n\n');
    sseClients.add(res);
    buildState().then((st) => res.write(`data: ${JSON.stringify(st)}\n\n`));
    const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch { /* */ } }, 25000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
  });

  // ---- settings / connections ----
  app.get('/api/settings', A(async (req, res) => {
    const gh = await run('gh', ['auth', 'status'], {});
    res.json({
      sources: cfg.sources || {},
      baseDirs: cfg.baseDirs || [],
      notify: cfg.notify || {},
      start: cfg.start || {},
      editors: cfg.editors || {},
      defaultEditor: cfg.defaultEditor || '',
      groups: cfg.groups || [],
      enabled: sources.enabled(cfg),
      tools: { gh: has('gh'), glab: has('glab') },
      githubAuthed: gh.code === 0,
    });
  }));
  app.post('/api/settings', A(async (req, res) => {
    const { sources: srcs, baseDirs, notify, start, editors, defaultEditor, groups } = req.body || {};
    if (srcs) {
      cfg.sources = cfg.sources || {};
      for (const k of Object.keys(srcs)) cfg.sources[k] = { ...(cfg.sources[k] || {}), ...srcs[k] };
    }
    if (notify && typeof notify === 'object') {
      cfg.notify = { ...(cfg.notify || {}), ...notify };
    }
    let rescanNeeded = false;
    if (Array.isArray(baseDirs)) {
      const { expandTilde } = require('./util');
      cfg.baseDirs = baseDirs.map((s) => expandTilde(String(s).trim())).filter(Boolean);
      rescanNeeded = true;
    }
    // Dev-server launch config { "<repo>": { cmd, ports:[…] } } — full replace, drop blank rows.
    if (start && typeof start === 'object' && !Array.isArray(start)) {
      const coercePorts = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,]+/))
        .map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0);
      const clean = {};
      for (const [repo, v] of Object.entries(start)) {
        const name = String(repo).trim();
        const cmd = v && typeof v === 'object' ? String(v.cmd || '').trim() : '';
        if (!name || !cmd) continue;
        clean[name] = { cmd, ports: coercePorts(v.ports) };
      }
      cfg.start = clean;
      rescanNeeded = true;
    }
    // Editors { "<name>": { open, openGroup? } } — full replace, drop blank rows.
    if (editors && typeof editors === 'object' && !Array.isArray(editors)) {
      const clean = {};
      for (const [nm, v] of Object.entries(editors)) {
        const name = String(nm).trim();
        const open = v && typeof v === 'object' ? String(v.open || '').trim() : '';
        if (!name || !open) continue;
        clean[name] = { open };
        if (v.openGroup && String(v.openGroup).trim()) clean[name].openGroup = String(v.openGroup).trim();
      }
      cfg.editors = clean;
    }
    if (typeof defaultEditor === 'string' && defaultEditor.trim()) cfg.defaultEditor = defaultEditor.trim();
    // Manual feature groups [{ name, members:[…] }] — full replace, drop blank rows.
    if (Array.isArray(groups)) {
      cfg.groups = groups.map((g) => ({
        name: String((g && g.name) || '').trim(),
        members: Array.isArray(g && g.members) ? g.members.map((m) => String(m).trim()).filter(Boolean) : [],
      })).filter((g) => g.name && g.members.length);
      rescanNeeded = true;
    }
    configMod.save(cfg);
    if (rescanNeeded) await rescan(); else scheduleBroadcast();
    res.json({
      ok: true,
      sources: cfg.sources,
      baseDirs: cfg.baseDirs,
      notify: cfg.notify,
      start: cfg.start,
      editors: cfg.editors,
      defaultEditor: cfg.defaultEditor,
      groups: cfg.groups,
      enabled: sources.enabled(cfg),
    });
  }));

  // ---- sources ----
  app.get('/api/sources', (req, res) => res.json(sources.enabled(cfg)));
  app.get('/api/sources/:source/items', A(async (req, res) => {
    const repo = repos.find((r) => r.name === req.query.repo);
    const out = await sources.list(cfg, req.params.source, { repoPath: repo && repo.path, q: req.query.q });
    res.json(out);
  }));

  // ---- sessions ----
  app.post('/api/sessions', A(async (req, res) => {
    try {
      const { source, sourceId, text, name, repo, additionalRepos } = req.body || {};
      const repoObj = repos.find((r) => r.name === repo);
      if (!repoObj) return res.status(400).json({ error: `unknown repo '${repo}'` });
      const seed = await sources.seed(cfg, source || 'freetext', { repoPath: repoObj.path, id: sourceId, text, name });
      const extra = (additionalRepos || [])
        .map((rn) => repos.find((r) => r.name === rn)).filter(Boolean)
        .map((r) => ({ repo: r.name, repoPath: r.path }));
      const session = await manager.create({ seed, repoPath: repoObj.path, repoName: repoObj.name, additionalRepos: extra });
      res.json(session);
    } catch (e) { res.status(500).json({ error: e.message }); }
  }));

  app.post('/api/sessions/:id/rename', A(async (req, res) => {
    res.json(await manager.rename(req.params.id, (req.body && req.body.title) || ''));
  }));
  app.post('/api/sessions/:id/deactivate', A(async (req, res) => { res.json(await manager.deactivate(req.params.id)); }));
  app.post('/api/sessions/:id/activate', A(async (req, res) => { res.json(await manager.activate(req.params.id)); }));

  // Add a repo to a session's feature (creates a same-named worktree + grants access).
  // Used by the UI button and the `wt-studio add-repo` CLI (David or claude).
  app.post('/api/sessions/:id/add-repo', A(async (req, res) => {
    const repoObj = repos.find((r) => r.name === (req.body && req.body.repo));
    if (!repoObj) return res.status(400).json({ error: `unknown repo '${req.body && req.body.repo}'` });
    const out = await manager.addRepo(req.params.id, { repo: repoObj.name, repoPath: repoObj.path });
    if (!out.ok) return res.status(400).json(out);
    await rescan(); // pick up the sibling worktree so the feature updates immediately
    res.json(out);
  }));

  app.post('/api/sessions/:id/promote', A(async (req, res) => {
    const out = await manager.promote(req.params.id, req.body || {});
    if (!out.ok) return res.status(400).json(out);
    await rescan(); // pick up the new worktree(s) so features update immediately
    res.json(out);
  }));

  app.post('/api/sessions/:id/tabs', A(async (req, res) => {
    res.json(await manager.addTab(req.params.id, req.body || {}));
  }));

  app.post('/api/sessions/:id/select-tab', A(async (req, res) => {
    res.json(await manager.selectTab(req.params.id, (req.body && req.body.index) || 0));
  }));

  app.post('/api/sessions/:id/close-tab', A(async (req, res) => {
    res.json(await manager.closeTab(req.params.id, (req.body && req.body.index) || 0));
  }));

  // Start / stop ALL dev servers of a session's shared workspace (every repo it owns).
  app.post('/api/sessions/:id/servers/start', A(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    const toStart = (s.repos || []).filter((x) => x.worktreePath && servers.startCfg(x.repo));
    const alloc = toStart.length ? servers.allocSlotFor(s.feature) : { slot: 0 };
    if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    const results = [];
    for (const r of toStart) {
      results.push({ repo: r.repo, ...(await servers.start(r.repo, r.worktreePath, servers.launchOpts(r.repo, s.feature))) });
    }
    await refreshRunning();
    scheduleBroadcast();
    res.json({ ok: results.some((r) => r.ok), results });
  }));
  app.post('/api/sessions/:id/servers/stop', A(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    for (const r of (s.repos || []).filter((x) => x.worktreePath)) await servers.stop(r.repo, r.worktreePath);
    servers.releaseSlot(s.feature); // whole stack stopped → free the feature's slot
    await refreshRunning();
    scheduleBroadcast();
    res.json({ ok: true });
  }));

  app.post('/api/sessions/:id/popout', A(async (req, res) => {
    const cmd = manager.popout(req.params.id);
    if (!cmd) return res.status(404).json({ error: 'no such session' });
    // open a native Terminal window attached to the same mux session
    const script = `tell application "Terminal" to do script ${JSON.stringify(cmd)}\ntell application "Terminal" to activate`;
    await run('osascript', ['-e', script]);
    res.json({ ok: true, cmd });
  }));

  app.delete('/api/sessions/:id', A(async (req, res) => {
    res.json(await manager.close(req.params.id, { kill: req.query.kill !== 'false' }));
  }));

  // ---- review (diff & commit) ----
  app.get('/api/sessions/:id/changes', A(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    const out = [];
    for (const entry of (s.repos || [])) {
      if (!entry.worktreePath) continue;
      const repoObj = repos.find((r) => r.name === entry.repo);
      const { base, files } = await review.changes(entry.worktreePath, repoObj && repoObj.defaultBranch);
      out.push({ repo: entry.repo, worktreePath: entry.worktreePath, base, files });
    }
    res.json({ repos: out });
  }));

  app.get('/api/sessions/:id/diff', A(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    const entry = (s.repos || []).find((r) => r.repo === req.query.repo);
    if (!entry || !entry.worktreePath) return res.status(400).json({ error: 'unknown repo or no worktree' });
    const repoObj = repos.find((r) => r.name === entry.repo);
    res.type('text/plain').send(await review.fileDiff(entry.worktreePath, repoObj && repoObj.defaultBranch, req.query.file));
  }));

  app.post('/api/sessions/:id/commit', A(async (req, res) => {
    const s = manager.get(req.params.id);
    const { repo, message, paths, amend } = req.body || {};
    if (!s) return res.status(400).json({ error: 'no such session' });
    const entry = (s.repos || []).find((r) => r.repo === repo);
    if (!entry || !entry.worktreePath) return res.status(400).json({ error: 'unknown repo or no worktree' });
    if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });
    const out = await review.commit(entry.worktreePath, message, { amend, paths });
    if (out.ok) scheduleBroadcast();
    res.json(out);
  }));

  // ---- worktrees (manual) ----
  app.post('/api/worktrees', A(async (req, res) => {
    const { repo, branch, name } = req.body || {};
    if (!branch && !name) return res.status(400).json({ error: 'branch or name is required' });
    const repoObj = repos.find((r) => r.name === repo);
    if (!repoObj) return res.status(400).json({ error: 'unknown repo' });
    const out = await worktree.create(repoObj.path, branch, name, {
      copyPatterns: (cfg.copyPatterns && (cfg.copyPatterns[repo] || cfg.copyPatterns.default)) || [],
    });
    await rescan();
    res.json(out);
  }));

  app.delete('/api/worktrees', A(async (req, res) => {
    const { repo, worktreePath, branch, deleteBranch } = req.body || {};
    const repoObj = repos.find((r) => r.name === repo);
    if (!repoObj) return res.status(400).json({ error: 'unknown repo' });
    const out = await worktree.remove(repoObj.path, worktreePath, { branch, deleteBranch });
    await rescan();
    res.json(out);
  }));

  // ---- dev servers ----
  app.post('/api/servers/start', A(async (req, res) => {
    const { repo, worktreePath } = req.body || {};
    const feature = featureFromPath(worktreePath);
    const alloc = servers.allocSlotFor(feature);
    if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    const out = await servers.start(repo, worktreePath, servers.launchOpts(repo, feature));
    await refreshRunning();
    scheduleBroadcast();
    res.json(out);
  }));
  app.post('/api/servers/stop', A(async (req, res) => {
    const { repo, worktreePath } = req.body || {};
    const out = await servers.stop(repo, worktreePath);
    await refreshRunning();
    // only free the feature's slot once no sibling repo of the feature is still running
    const feature = featureFromPath(worktreePath);
    if (![...runningCache.keys()].some((p) => featureFromPath(p) === feature)) servers.releaseSlot(feature);
    scheduleBroadcast();
    res.json(out);
  }));
  app.post('/api/servers/restart', A(async (req, res) => {
    const { repo, worktreePath } = req.body || {};
    const feature = featureFromPath(worktreePath);
    const alloc = servers.allocSlotFor(feature); // reuse the feature's slot across the restart
    if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    const out = await servers.restart(repo, worktreePath, servers.launchOpts(repo, feature));
    await refreshRunning();
    scheduleBroadcast();
    res.json(out);
  }));
  app.get('/api/servers/logs', (req, res) => {
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
    res.json(servers.logs(req.query.worktreePath, { offset }));
  });

  // ---- feature/group orchestration (run whole stack · stop & switch) ----
  app.post('/api/group/start', A(async (req, res) => {
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
    if (toStart.length) {
      const alloc = servers.allocSlotFor(g.name);
      if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    }
    let started = 0; const failures = [];
    await Promise.all(toStart.map(async (m) => {
      const r = await servers.start(m.repo, m.path, servers.launchOpts(m.repo, g.name));
      if (r.ok) started++; else failures.push({ repo: m.repo, error: r.error });
    }));
    await refreshRunning();
    scheduleBroadcast();
    res.json({ ok: true, started, total: toStart.length, failures });
  }));
  app.post('/api/group/stop', A(async (req, res) => {
    const { group } = req.body || {};
    const { group: g } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    await Promise.all(g.members.filter((m) => m.running).map((m) => servers.stop(m.repo, m.path)));
    servers.releaseSlot(g.name); // whole stack stopped → free the feature's slot
    await refreshRunning();
    scheduleBroadcast();
    res.json({ ok: true });
  }));
  app.post('/api/group/restart', A(async (req, res) => {
    const { group } = req.body || {};
    const { group: g } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const alloc = servers.allocSlotFor(g.name); // reuse the feature's slot across the restart
    if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    await Promise.all(g.members.filter((m) => m.running || m.canStart).map((m) => servers.restart(m.repo, m.path, servers.launchOpts(m.repo, g.name))));
    await refreshRunning();
    scheduleBroadcast();
    res.json({ ok: true });
  }));
  app.post('/api/group/open', A(async (req, res) => {
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
  app.post('/api/group/close', A(async (req, res) => {
    const { group: g } = await resolveGroup(req.body && req.body.group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    for (const m of g.members) {
      if (m.running) await servers.stop(m.repo, m.path);
      if (m.session) await manager.deactivate(m.session.id);
    }
    servers.releaseSlot(g.name); // whole stack stopped → free the feature's slot
    scheduleBroadcast();
    res.json({ ok: true });
  }));

  // Delete a feature: kill its sessions + remove its worktrees (optionally branches).
  app.post('/api/group/delete', A(async (req, res) => {
    const { group, deleteBranches } = req.body || {};
    const { group: g } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const results = [];
    for (const m of g.members) {
      const repoObj = repos.find((r) => r.name === m.repo);
      if (!repoObj) { results.push({ repo: m.repo, ok: false, error: 'unknown repo' }); continue; }
      if (m.running) await servers.stop(m.repo, m.path);
      if (m.session) await manager.close(m.session.id);
      const rr = await worktree.remove(repoObj.path, m.path, { branch: m.branch, deleteBranch: deleteBranches });
      results.push({ repo: m.repo, ok: rr.ok, error: rr.error });
    }
    servers.releaseSlot(g.name); // feature removed → free its slot
    await rescan();
    res.json({ ok: results.every((r) => r.ok), results });
  }));

  // Open a PR (gh) / MR (glab) for each of a feature's branches.
  app.post('/api/group/pr', A(async (req, res) => {
    const { group: g } = await resolveGroup(req.body && req.body.group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
    const results = [];
    for (const m of g.members) {
      await run('git', ['-C', m.path, 'push', '-u', 'origin', m.branch], { env });
      let r = await run('gh', ['pr', 'create', '--fill', '--head', m.branch], { cwd: m.path, env });
      if (r.code === 0) { results.push({ repo: m.repo, url: r.stdout.trim().split('\n').pop() }); continue; }
      r = await run('glab', ['mr', 'create', '--fill', '--yes'], { cwd: m.path, env });
      if (r.code === 0) { results.push({ repo: m.repo, url: (r.stdout.match(/https?:\/\/\S+/) || ['created'])[0] }); continue; }
      results.push({ repo: m.repo, error: (r.stderr || '').trim().split('\n')[0] || 'gh/glab unavailable or failed' });
    }
    res.json({ ok: results.some((r) => r.url), results });
  }));

  // ---- PR / CI status (serverbar pill) ----
  // gh/glab lookups cached per worktreePath+branch for ~20s so UI polling doesn't
  // hammer the CLIs. Value: { at, data } where data is the per-repo result.
  const ciCache = new Map();
  const CI_TTL = 20000;
  const hasGh = has('gh');
  const hasGlab = has('glab');

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
      if (hasGh) {
        const r = await run('gh', ['pr', 'view', branch, '--json', 'number,url,state,statusCheckRollup'], { cwd: worktreePath, env });
        if (r.code === 0 && r.stdout.trim()) {
          const j = JSON.parse(r.stdout);
          data = { repo, hasPR: true, provider: 'github', number: j.number, url: j.url, state: j.state, checks: ghChecks(j.statusCheckRollup) };
        }
      }
      if (!data.hasPR && hasGlab) {
        const r = await run('glab', ['mr', 'view', branch, '-F', 'json'], { cwd: worktreePath, env });
        if (r.code === 0 && r.stdout.trim()) {
          const j = JSON.parse(r.stdout);
          const pipe = j.pipeline || j.head_pipeline || {};
          data = { repo, hasPR: true, provider: 'gitlab', number: j.iid, url: j.web_url, state: j.state, checks: glChecks(pipe.status) };
        }
      }
    } catch { data = { repo, hasPR: false }; }
    ciCache.set(key, { at: Date.now(), data });
    return { ...data, repo };
  }

  app.get('/api/sessions/:id/ci', A(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    const entries = (s.repos || []).filter((r) => r.worktreePath && r.branch);
    // Neither CLI installed → answer instantly without shelling out.
    if (!hasGh && !hasGlab) return res.json({ repos: entries.map((r) => ({ repo: r.repo, hasPR: false })) });
    const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
    const repos = [];
    for (const entry of entries) {
      try { repos.push(await ciForRepo(entry, env)); }
      catch { repos.push({ repo: entry.repo, hasPR: false }); }
    }
    res.json({ repos });
  }));

  // One session per feature: return the existing one, or start a single session
  // that drives ALL the feature's worktrees (adopt the first, /add-dir the rest).
  app.post('/api/group/session', A(async (req, res) => {
    const { group: g } = await resolveGroup(req.body && req.body.group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const members = g.members;
    if (!members.length) return res.status(400).json({ error: 'feature has no members' });
    for (const m of members) { const s = manager.sessionForWorktree(m.path); if (s) return res.json({ ok: true, session: s, existed: true }); }
    const [primary, ...rest] = members;
    const pRepo = repos.find((r) => r.name === primary.repo);
    const session = await manager.adopt({ worktreePath: primary.path, repoName: primary.repo, repoPath: pRepo.path, branch: primary.branch, wtname: primary.wtname });
    if (session) {
      for (const m of rest) {
        const ro = repos.find((r) => r.name === m.repo);
        if (ro) await manager.attachRepo(session.id, { repo: m.repo, repoPath: ro.path, worktreePath: m.path, branch: m.branch, wtname: m.wtname });
      }
    }
    scheduleBroadcast();
    res.json({ ok: true, session });
  }));

  // Start a session in an existing worktree (Fleet: "Start session here")
  app.post('/api/worktrees/adopt', A(async (req, res) => {
    const { repo, worktreePath, branch, wtname } = req.body || {};
    if (!worktreePath) return res.status(400).json({ error: 'worktreePath is required' });
    const repoObj = repos.find((r) => r.name === repo);
    if (!repoObj) return res.status(400).json({ error: 'unknown repo' });
    let s = await manager.adopt({ worktreePath, repoName: repo, repoPath: repoObj.path, branch, wtname });
    if (!s) s = manager.sessionForWorktree(worktreePath); // an adopt was already in flight
    scheduleBroadcast();
    res.json(s || { error: 'session is already being opened' });
  }));

  // ---- editor open ----
  app.post('/api/open', A(async (req, res) => {
    const { path: p, editor } = req.body || {};
    const ed = (cfg.editors && (cfg.editors[editor] || cfg.editors[cfg.defaultEditor])) || null;
    if (!ed) return res.status(400).json({ error: 'no editor configured' });
    const cmd = ed.open.replace('{path}', shq(p));
    await run('bash', ['-lc', cmd]);
    res.json({ ok: true });
  }));

  // ---- Claude Code hook receiver ----
  app.post('/hook/:event', (req, res) => {
    const id = req.query.wts;
    let payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = { raw: payload }; } }
    if (id) manager.applyHook(id, req.params.event, payload || {});
    res.json({ ok: true });
  });

  // ---- HTTP + WS ----
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws/term' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('session');
    const cols = Number(url.searchParams.get('cols')) || 100;
    const rows = Number(url.searchParams.get('rows')) || 30;
    const s = manager.get(id);
    if (!s) { ws.close(); return; }
    const spec = manager.mux.attachSpawn(s.muxName);
    const term = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color', cols, rows, cwd: s.worktreePath || s.repoPath, env: spec.env || process.env,
    });
    term.onData((d) => { try { ws.send(d); } catch { /* */ } });
    term.onExit(() => { try { ws.close(); } catch { /* */ } });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { term.write(data.toString('utf8')); return; }
      const txt = data.toString('utf8');
      try {
        const msg = JSON.parse(txt);
        if (msg.type === 'resize') { term.resize(Math.max(2, msg.cols | 0), Math.max(2, msg.rows | 0)); return; }
        if (msg.type === 'input') { term.write(msg.data); return; }
      } catch { term.write(txt); }
    });
    ws.on('close', () => { try { term.kill(); } catch { /* */ } });
  });

  // ---- boot ----
  process.on('unhandledRejection', (e) => console.error('[wt-studio] unhandledRejection', e));
  process.on('uncaughtException', (e) => console.error('[wt-studio] uncaughtException', e));
  await rescan();
  setInterval(rescan, 15000);
  await refreshRunning();
  setInterval(refreshRunning, 3000);
  const restored = await manager.restore().catch(() => 0);
  if (restored) console.log(`[wt-studio] restored ${restored} session(s)`);

  server.listen(cfg.web.port, cfg.web.host, () => {
    console.log(`[wt-studio] http://${cfg.web.host}:${cfg.web.port}  (${repos.length} repos, mux=${mux ? mux.name : 'none'})`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
