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
const sources = require('./sources');
const { SessionManager } = require('./sessions');
const { Servers } = require('./servers');
const { computeFeatures } = require('./features');
const { run, has } = require('./util');

async function main() {
  const cfg = configMod.load();
  const mux = await muxSelect.select(cfg.multiplexer);
  if (!mux) {
    console.error('[wt-studio] no multiplexer available (need zellij or tmux). Install one and retry.');
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

  // Unified state: every worktree decorated with discovered server state + its
  // session (if any), grouped into features. Superset of worktree-dash's contract.
  async function buildState() {
    const running = await servers.discoverRunning();
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
    // per-session server state (Work-view compatibility)
    const serversById = {};
    for (const s of sessions) {
      if (s.worktreePath) {
        const hit = running.get(require('./servers').realpath(s.worktreePath));
        serversById[s.id] = { configured: !!servers.startCfg(s.repoName), running: !!hit, ports: hit ? hit.ports.map((p) => ({ port: p, up: true })) : [], pid: hit ? hit.pid : null };
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

  app.get('/api/state', async (req, res) => res.json(await buildState()));

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
  app.get('/api/settings', async (req, res) => {
    const gh = await run('gh', ['auth', 'status'], {});
    res.json({
      sources: cfg.sources || {},
      enabled: sources.enabled(cfg),
      tools: { gh: has('gh'), glab: has('glab') },
      githubAuthed: gh.code === 0,
    });
  });
  app.post('/api/settings', (req, res) => {
    const { sources: srcs } = req.body || {};
    if (srcs) {
      cfg.sources = cfg.sources || {};
      for (const k of Object.keys(srcs)) cfg.sources[k] = { ...(cfg.sources[k] || {}), ...srcs[k] };
    }
    configMod.save(cfg);
    scheduleBroadcast();
    res.json({ ok: true, sources: cfg.sources, enabled: sources.enabled(cfg) });
  });

  // ---- sources ----
  app.get('/api/sources', (req, res) => res.json(sources.enabled(cfg)));
  app.get('/api/sources/:source/items', async (req, res) => {
    const repo = repos.find((r) => r.name === req.query.repo);
    const out = await sources.list(cfg, req.params.source, { repoPath: repo && repo.path, q: req.query.q });
    res.json(out);
  });

  // ---- sessions ----
  app.post('/api/sessions', async (req, res) => {
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
  });

  app.post('/api/sessions/:id/rename', async (req, res) => {
    res.json(await manager.rename(req.params.id, (req.body && req.body.title) || ''));
  });
  app.post('/api/sessions/:id/deactivate', async (req, res) => { res.json(await manager.deactivate(req.params.id)); });
  app.post('/api/sessions/:id/activate', async (req, res) => { res.json(await manager.activate(req.params.id)); });

  // Add a repo to a session's feature (creates a same-named worktree + grants access).
  // Used by the UI button and the `wt-studio add-repo` CLI (David or claude).
  app.post('/api/sessions/:id/add-repo', async (req, res) => {
    const repoObj = repos.find((r) => r.name === (req.body && req.body.repo));
    if (!repoObj) return res.status(400).json({ error: `unknown repo '${req.body && req.body.repo}'` });
    const out = await manager.addRepo(req.params.id, { repo: repoObj.name, repoPath: repoObj.path });
    if (!out.ok) return res.status(400).json(out);
    await rescan(); // pick up the sibling worktree so the feature updates immediately
    res.json(out);
  });

  app.post('/api/sessions/:id/promote', async (req, res) => {
    const out = await manager.promote(req.params.id, req.body || {});
    if (!out.ok) return res.status(400).json(out);
    await rescan(); // pick up the new worktree(s) so features update immediately
    res.json(out);
  });

  app.post('/api/sessions/:id/tabs', async (req, res) => {
    res.json(await manager.addTab(req.params.id, req.body || {}));
  });

  app.post('/api/sessions/:id/select-tab', async (req, res) => {
    res.json(await manager.selectTab(req.params.id, (req.body && req.body.index) || 0));
  });

  app.post('/api/sessions/:id/close-tab', async (req, res) => {
    res.json(await manager.closeTab(req.params.id, (req.body && req.body.index) || 0));
  });

  app.post('/api/sessions/:id/popout', async (req, res) => {
    const cmd = manager.popout(req.params.id);
    if (!cmd) return res.status(404).json({ error: 'no such session' });
    // open a native Terminal window attached to the same mux session
    const script = `tell application "Terminal" to do script ${JSON.stringify(cmd)}\ntell application "Terminal" to activate`;
    await run('osascript', ['-e', script]);
    res.json({ ok: true, cmd });
  });

  app.delete('/api/sessions/:id', async (req, res) => {
    res.json(await manager.close(req.params.id, { kill: req.query.kill !== 'false' }));
  });

  // ---- worktrees (manual) ----
  app.post('/api/worktrees', async (req, res) => {
    const { repo, branch, name } = req.body || {};
    const repoObj = repos.find((r) => r.name === repo);
    if (!repoObj) return res.status(400).json({ error: 'unknown repo' });
    const out = await worktree.create(repoObj.path, branch, name, {
      copyPatterns: (cfg.copyPatterns && (cfg.copyPatterns[repo] || cfg.copyPatterns.default)) || [],
    });
    await rescan();
    res.json(out);
  });

  app.delete('/api/worktrees', async (req, res) => {
    const { repo, worktreePath, branch, deleteBranch } = req.body || {};
    const repoObj = repos.find((r) => r.name === repo);
    if (!repoObj) return res.status(400).json({ error: 'unknown repo' });
    const out = await worktree.remove(repoObj.path, worktreePath, { branch, deleteBranch });
    await rescan();
    res.json(out);
  });

  // ---- dev servers ----
  app.post('/api/servers/start', async (req, res) => {
    const { repo, worktreePath } = req.body || {};
    const out = await servers.start(repo, worktreePath);
    scheduleBroadcast();
    res.json(out);
  });
  app.post('/api/servers/stop', async (req, res) => {
    const { repo, worktreePath } = req.body || {};
    const out = await servers.stop(repo, worktreePath);
    scheduleBroadcast();
    res.json(out);
  });
  app.post('/api/servers/restart', async (req, res) => {
    const { repo, worktreePath } = req.body || {};
    const out = await servers.restart(repo, worktreePath);
    scheduleBroadcast();
    res.json(out);
  });
  app.get('/api/servers/logs', (req, res) => res.type('text/plain').send(servers.logs(req.query.worktreePath)));

  // ---- feature/group orchestration (run whole stack · stop & switch) ----
  app.post('/api/group/start', async (req, res) => {
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
    let started = 0; const failures = [];
    await Promise.all(toStart.map(async (m) => {
      const r = await servers.start(m.repo, m.path);
      if (r.ok) started++; else failures.push({ repo: m.repo, error: r.error });
    }));
    scheduleBroadcast();
    res.json({ ok: true, started, total: toStart.length, failures });
  });
  app.post('/api/group/stop', async (req, res) => {
    const { group } = req.body || {};
    const { group: g } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    await Promise.all(g.members.filter((m) => m.running).map((m) => servers.stop(m.repo, m.path)));
    scheduleBroadcast();
    res.json({ ok: true });
  });
  app.post('/api/group/restart', async (req, res) => {
    const { group } = req.body || {};
    const { group: g } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    await Promise.all(g.members.filter((m) => m.running || m.canStart).map((m) => servers.restart(m.repo, m.path)));
    scheduleBroadcast();
    res.json({ ok: true });
  });
  app.post('/api/group/open', async (req, res) => {
    const { group, editor } = req.body || {};
    const { group: g } = await resolveGroup(group);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const ed = (cfg.editors && (cfg.editors[editor] || cfg.editors[cfg.defaultEditor])) || null;
    if (!ed) return res.status(400).json({ error: 'no editor configured' });
    const paths = g.members.map((m) => m.path);
    if (ed.openGroup) { await run('bash', ['-lc', ed.openGroup.replace('{paths}', paths.map((p) => `'${p}'`).join(' '))]); }
    else { for (const p of paths) await run('bash', ['-lc', ed.open.replace('{path}', p)]); }
    res.json({ ok: true });
  });

  // Start a session in an existing worktree (Fleet: "Start session here")
  app.post('/api/worktrees/adopt', async (req, res) => {
    const { repo, worktreePath, branch, wtname } = req.body || {};
    const repoObj = repos.find((r) => r.name === repo);
    if (!repoObj) return res.status(400).json({ error: 'unknown repo' });
    const s = await manager.adopt({ worktreePath, repoName: repo, repoPath: repoObj.path, branch, wtname });
    scheduleBroadcast();
    res.json(s);
  });

  // ---- editor open ----
  app.post('/api/open', async (req, res) => {
    const { path: p, editor } = req.body || {};
    const ed = (cfg.editors && (cfg.editors[editor] || cfg.editors[cfg.defaultEditor])) || null;
    if (!ed) return res.status(400).json({ error: 'no editor configured' });
    const cmd = ed.open.replace('{path}', p);
    await run('bash', ['-lc', cmd]);
    res.json({ ok: true });
  });

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
  await rescan();
  setInterval(rescan, 15000);
  const restored = await manager.restore().catch(() => 0);
  if (restored) console.log(`[wt-studio] restored ${restored} session(s)`);

  server.listen(cfg.web.port, cfg.web.host, () => {
    console.log(`[wt-studio] http://${cfg.web.host}:${cfg.web.port}  (${repos.length} repos, mux=${mux ? mux.name : 'none'})`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
