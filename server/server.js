'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const configMod = require('./config');
const muxSelect = require('./multiplexer');
const gitMod = require('./git');
const watchMod = require('./watch');
const worktree = require('./worktree');
const { worktreeCopyOpts } = worktree;
const review = require('./review');
const sources = require('./sources');
const { SessionManager } = require('./sessions');
const { Servers } = require('./servers');
const { createIdentity } = require('./identity');
const { createState } = require('./state');
const { createBroadcast } = require('./broadcast');
const { createForge } = require('./forge');
const { createCiFeed } = require('./ci');
const orchestrator = require('./orchestrator');
const { createGuard } = require('./security');
const crash = require('./crash');
const { run, has, shq, A } = require('./util');

async function main() {
  const cfg = configMod.load();
  const mux = await muxSelect.select();
  if (!mux) {
    console.error('[wt-studio] tmux not found — install it (brew install tmux) and retry.');
  } else {
    console.log(`[wt-studio] multiplexer: ${mux.name}`);
  }

  // One feature-identity resolver for the whole process: state.js groups worktrees
  // with it, servers.js keys concurrency slots with it and sessions.js records it
  // on each session, so none of the three can drift.
  const identity = createIdentity(cfg);
  const manager = new SessionManager(cfg, mux || require('./multiplexer/tmux'), identity);
  const servers = new Servers(cfg, identity);

  // ---- repo scan cache ----
  let repos = [];
  let scanning = false;
  async function rescan() {
    if (scanning) return;
    scanning = true;
    try { repos = await gitMod.scan(cfg.baseDirs, cfg.scanDepth); } catch (e) { /* */ }
    // The scan is the only thing that knows each worktree's branch, and the
    // branch/manifest identity strategies need it to answer from a path alone.
    identity.reindex(repos);
    scanning = false;
    prunePaths();        // the fresh scan is what says which worktrees still exist
    broadcastTopology(); // the scan IS the topology
    // A scan is also the server's only notice that git moved. watch.js arms
    // fs.watch on `.git/refs` (recursive), so a commit writes refs/heads/<branch>,
    // a push writes refs/remotes/origin/<branch>, and a branch switch writes HEAD —
    // each lands here. Those are precisely the three local events that change what
    // `gh pr view` would answer, so this is the CI feed's main trigger. Fire and
    // forget: the feed debounces, floors and gates it, and nothing here waits.
    ciFeed.poke({ force: true });
  }

  // Cached lsof discovery — refreshed on a timer and after mutations, not on
  // every SSE broadcast (which fires per Claude hook → per tool call).
  let runningCache = new Map();
  let runningSig = '';
  async function refreshRunning() {
    try {
      runningCache = await servers.discoverRunning();
      servers.reconcileSlots(runningCache); // self-heal leaked/stale slots against reality
    } catch { return; }
    // Discovery feeds the topology half (each worktree's running/ports), so a new
    // or vanished server has to push one — but only when what lsof found actually
    // changed, or this 3 s timer would re-send the slow half 20 times a minute.
    const sig = [...runningCache].map(([p, v]) => `${p}:${(v.ports || []).join(',')}`).sort().join('|');
    if (sig === runningSig) return;
    runningSig = sig;
    broadcastTopology();
  }

  // The state payload lives in state.js; both caches above are handed over as
  // getters because each is replaced (not mutated) on every refresh.
  const { buildState, topology, sessionState, prunePaths, resolveGroup, conflictsFor } = createState({
    cfg, manager, servers, mux, identity, repos: () => repos, running: () => runningCache,
  });

  // ---- SSE live state ----
  // Two named event types with very different rates (see broadcast.js).
  // scheduleBroadcast() sends the small session half only — that is what every
  // Claude hook gets. broadcastTopology() adds the slow half and is called by the
  // handful of things that can actually change the repo → worktree shape (a git
  // rescan, a worktree/session mutation, dev-server discovery, a config save).
  // ---- PR/MR + CI status (serverbar pill) ----
  // Pushed, not polled. Three objects that each only reach the next one at call
  // time: the forge does the lookups and tells the feed when it opened a PR, the
  // feed owns the snapshot and decides when to look, the bus carries the result.
  const forge = createForge({ manager, resolveGroup, onChanged: () => ciFeed.poke({ force: true }) });
  const ciFeed = createCiFeed({
    forge,
    sessions: () => manager.all(),
    streams: () => bus.clients.size, // an SSE subscriber is the only thing a `ci` frame can reach
    onChange: () => bus.schedule({ ci: true }),
  });

  const bus = createBroadcast({ topology, sessionState, ci: ciFeed.snapshot });
  const scheduleBroadcast = () => bus.schedule();
  const broadcastTopology = () => bus.schedule({ topology: true });

  // Paces the watcher's sweeps. Only the browser subscribes to /api/events — SwiftBar
  // polls /api/state every 10s and Alfred once per keystroke — so a recent poll has to
  // count as "someone is looking" too, or the menubar's server dots go minutes stale.
  const attention = watchMod.attention({ streams: () => bus.clients.size });
  manager.on('change', scheduleBroadcast);

  // ---- express ----
  const app = express();

  // Everything below sits behind the Host/Origin allowlist — see security.js for
  // what each gate stops. It runs before the body parsers so a rejected request is
  // never given the chance to make us buffer 8 MB of its JSON.
  const guard = createGuard({ cfg, token: cfg._token });
  app.use(guard.browser);

  app.use(express.json({ limit: '8mb' }));
  app.use(express.text({ type: 'text/*', limit: '8mb' }));

  // The browser tab cannot be handed a header before it exists, so the boot token is
  // injected into the one document we hand it. That is safe precisely because of the
  // gate above: a cross-origin page cannot read this response body, and a rebinding
  // page is refused before there is a body to read. no-store keeps the token out of
  // the disk cache.
  const INDEX = path.join(__dirname, '..', 'public', 'index.html');
  app.get(['/', '/index.html'], (req, res) => {
    let html;
    try { html = fs.readFileSync(INDEX, 'utf8'); } catch { return res.status(500).send('index.html is missing'); }
    return res.type('html').set('Cache-Control', 'no-store').send(html.replace('__WTS_TOKEN__', cfg._token));
  });
  // index:false so the directory listing never serves the un-injected index.html.
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

  // Every API route needs the boot token. The Origin/Host gate above only constrains
  // browsers; this is what stops any other local process — or a browser request that
  // carries no Origin at all — from driving the studio. It goes on the /api PREFIX
  // rather than on the router below, so it also covers the routers other modules
  // mount there themselves (transcript-routes); /api/v1 is nested under /api, so one
  // line covers both prefixes.
  app.use('/api', guard.authed);

  // Every route below is registered once on this router and served at BOTH
  // /api/v1/* (the versioned contract new clients should use) and /api/* (the
  // unversioned aliases SwiftBar, Alfred and the current web UI already call).
  // Feature modules register onto the same router — one line each, see below.
  const api = express.Router();
  app.use('/api', api);
  app.use('/api/v1', api);

  // attention.seen(): SwiftBar and Alfred poll this route instead of subscribing to
  // /api/events, so a poll is what tells the watcher someone is still looking.
  api.get('/state', A(async (req, res) => { attention.seen(); res.json(await buildState()); }));

  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    // subscribe() writes the full snapshot (one `topology` + one `session-state`)
    // before this client joins the fan-out, so it can never miss the snapshot or
    // see an event that predates it.
    const unsubscribe = bus.subscribe(res);
    // Someone started looking. While nobody was, the CI feed deliberately did
    // nothing at all, so its snapshot may be stale or empty — this is what makes an
    // opened dashboard fill in within a second rather than at the next safety net.
    ciFeed.poke();
    const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch { /* */ } }, 25000);
    req.on('close', () => { clearInterval(hb); unsubscribe(); });
  });

  // ---- settings / connections ----
  api.get('/settings', A(async (req, res) => {
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
  api.post('/settings', A(async (req, res) => {
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
    if (rescanNeeded) await rescan(); else broadcastTopology();
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
  api.get('/sources', (req, res) => res.json(sources.enabled(cfg)));
  api.get('/sources/:source/items', A(async (req, res) => {
    const repo = repos.find((r) => r.name === req.query.repo);
    const out = await sources.list(cfg, req.params.source, { repoPath: repo && repo.path, q: req.query.q });
    res.json(out);
  }));

  // ---- sessions ----
  api.post('/sessions', A(async (req, res) => {
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

  api.post('/sessions/:id/rename', A(async (req, res) => {
    res.json(await manager.rename(req.params.id, (req.body && req.body.title) || ''));
  }));
  api.post('/sessions/:id/deactivate', A(async (req, res) => { res.json(await manager.deactivate(req.params.id)); }));
  api.post('/sessions/:id/activate', A(async (req, res) => { res.json(await manager.activate(req.params.id)); }));

  // Add a repo to a session's feature (creates a same-named worktree + grants access).
  // Used by the UI button and the `wt-studio add-repo` CLI (David or claude).
  api.post('/sessions/:id/add-repo', A(async (req, res) => {
    const repoObj = repos.find((r) => r.name === (req.body && req.body.repo));
    if (!repoObj) return res.status(400).json({ error: `unknown repo '${req.body && req.body.repo}'` });
    const out = await manager.addRepo(req.params.id, { repo: repoObj.name, repoPath: repoObj.path });
    if (!out.ok) return res.status(400).json(out);
    await rescan(); // pick up the sibling worktree so the feature updates immediately
    res.json(out);
  }));

  api.post('/sessions/:id/promote', A(async (req, res) => {
    const out = await manager.promote(req.params.id, req.body || {});
    // Dirty-main warning: 200 (not 400) so the client can read needsConfirm and re-prompt.
    if (out.needsConfirm) return res.json(out);
    if (!out.ok) return res.status(400).json(out);
    await rescan(); // pick up the new worktree(s) so features update immediately
    res.json(out);
  }));

  api.post('/sessions/:id/tabs', A(async (req, res) => {
    res.json(await manager.addTab(req.params.id, req.body || {}));
  }));

  api.post('/sessions/:id/select-tab', A(async (req, res) => {
    res.json(await manager.selectTab(req.params.id, (req.body && req.body.index) || 0));
  }));

  // The split pane is a standalone `-split` session with its own tabs. These operate on
  // it directly through the mux (tmux is the source of truth for its window list).
  api.get('/sessions/:id/split/tabs', A(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    await manager.mux.ensureSplit(s.muxName, { cwd: s.worktreePath || s.repoPath });
    res.json({ tabs: await manager.mux.listTabs(`${s.muxName}-split`) });
  }));
  api.post('/sessions/:id/split/tabs', A(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    await manager.mux.ensureSplit(s.muxName, { cwd: s.worktreePath || s.repoPath });
    const r = await manager.mux.newTab(`${s.muxName}-split`, { title: (req.body && req.body.title) || 'shell', cwd: s.worktreePath || s.repoPath });
    res.json(r);
  }));
  api.post('/sessions/:id/split/select-tab', A(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    res.json({ ok: await manager.mux.selectTab(`${s.muxName}-split`, (req.body && req.body.index) || 0) });
  }));
  api.post('/sessions/:id/split/close-tab', A(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    res.json({ ok: await manager.mux.closeTab(`${s.muxName}-split`, (req.body && req.body.index) || 0) });
  }));

  api.post('/sessions/:id/close-tab', A(async (req, res) => {
    res.json(await manager.closeTab(req.params.id, (req.body && req.body.index) || 0));
  }));

  // Start / stop ALL dev servers of a session's shared workspace (every repo it owns).
  api.post('/sessions/:id/servers/start', A(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    const toStart = (s.repos || []).filter((x) => x.worktreePath && servers.startCfg(x.repo));
    // Key the slot on the per-worktree feature identity (server/identity.js) — the
    // one canonical key used everywhere. A session's repos resolve to the same
    // identity → one slot.
    for (const r of toStart) {
      const alloc = servers.allocSlotFor(servers.featureFor(r.worktreePath));
      if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    }
    const results = [];
    for (const r of toStart) {
      const feat = servers.featureFor(r.worktreePath);
      results.push({ repo: r.repo, ...(await servers.start(r.repo, r.worktreePath, servers.launchOpts(r.repo, feat))) });
    }
    await refreshRunning();
    broadcastTopology();
    res.json({ ok: results.some((r) => r.ok), results });
  }));
  api.post('/sessions/:id/servers/stop', A(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    const owned = (s.repos || []).filter((x) => x.worktreePath);
    for (const r of owned) await servers.stop(r.repo, r.worktreePath);
    for (const r of owned) servers.releaseSlot(servers.featureFor(r.worktreePath)); // whole stack stopped → free the feature's slot
    await refreshRunning();
    broadcastTopology();
    res.json({ ok: true });
  }));

  api.post('/sessions/:id/popout', A(async (req, res) => {
    const cmd = manager.popout(req.params.id);
    if (!cmd) return res.status(404).json({ error: 'no such session' });
    // open a native Terminal window attached to the same mux session
    const script = `tell application "Terminal" to do script ${JSON.stringify(cmd)}\ntell application "Terminal" to activate`;
    await run('osascript', ['-e', script]);
    res.json({ ok: true, cmd });
  }));

  api.delete('/sessions/:id', A(async (req, res) => {
    // Capture the session BEFORE close (close deletes it). Mirror /api/group/delete's
    // orphan cleanup: stop each owned worktree's dev servers + release its slot, else a
    // running server is orphaned and its concurrency slot leaks.
    const s = manager.get(req.params.id);
    const owned = s ? (s.repos || []).filter((r) => r.worktreePath) : [];
    for (const r of owned) await servers.stop(r.repo, r.worktreePath);
    const out = await manager.close(req.params.id, { kill: req.query.kill !== 'false' });
    for (const r of owned) servers.releaseSlot(servers.featureFor(r.worktreePath));
    if (owned.length) { await refreshRunning(); broadcastTopology(); }
    res.json(out);
  }));

  // ---- review (commits, per-commit diffs & commit) ----
  // The branch's commits per repo (+ an uncommitted summary), and one commit's inline
  // per-file diffs on demand.
  api.get('/sessions/:id/commits', A(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    const out = [];
    for (const entry of (s.repos || [])) {
      if (!entry.worktreePath) continue;
      const repoObj = repos.find((r) => r.name === entry.repo);
      const def = repoObj && repoObj.defaultBranch;
      const { base, commits } = await review.commits(entry.worktreePath, def);
      const wc = await review.working(entry.worktreePath);
      const uncommitted = {
        fileCount: wc.files.length,
        added: wc.files.reduce((n, f) => n + (f.added || 0), 0),
        deleted: wc.files.reduce((n, f) => n + (f.deleted || 0), 0),
      };
      out.push({ repo: entry.repo, worktreePath: entry.worktreePath, branch: entry.branch, base, defaultBranch: def, commits, uncommitted });
    }
    res.json({ repos: out });
  }));

  api.get('/sessions/:id/commit-detail', A(async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    const entry = (s.repos || []).find((r) => r.repo === req.query.repo);
    if (!entry || !entry.worktreePath) return res.status(400).json({ error: 'unknown repo or no worktree' });
    const repoObj = repos.find((r) => r.name === entry.repo);
    res.json(await review.commitDetail(entry.worktreePath, repoObj && repoObj.defaultBranch, req.query.sha || 'uncommitted'));
  }));

  api.post('/sessions/:id/commit', A(async (req, res) => {
    const s = manager.get(req.params.id);
    const { repo, message, paths, amend } = req.body || {};
    if (!s) return res.status(400).json({ error: 'no such session' });
    const entry = (s.repos || []).find((r) => r.repo === repo);
    if (!entry || !entry.worktreePath) return res.status(400).json({ error: 'unknown repo or no worktree' });
    if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });
    const out = await review.commit(entry.worktreePath, message, { amend, paths });
    // A commit made through the UI writes refs/heads/<branch>, so the watcher would
    // find it anyway — but it can take a debounce plus a scan to get here, and we
    // already know. Poke directly rather than wait to be told what we just did.
    if (out.ok) { broadcastTopology(); ciFeed.poke({ force: true }); }
    res.json(out);
  }));

  // ---- worktrees (manual) ----
  api.post('/worktrees', A(async (req, res) => {
    const { repo, branch, name } = req.body || {};
    if (!branch && !name) return res.status(400).json({ error: 'branch or name is required' });
    const repoObj = repos.find((r) => r.name === repo);
    if (!repoObj) return res.status(400).json({ error: 'unknown repo' });
    const out = await worktree.create(repoObj.path, branch, name, {
      layout: identity.layout,
      ...worktreeCopyOpts(cfg, repo),
    });
    await rescan();
    res.json(out);
  }));

  api.delete('/worktrees', A(async (req, res) => {
    const { repo, worktreePath, branch, deleteBranch } = req.body || {};
    const repoObj = repos.find((r) => r.name === repo);
    if (!repoObj) return res.status(400).json({ error: 'unknown repo' });
    const out = await worktree.remove(repoObj.path, worktreePath, { branch, deleteBranch });
    await rescan();
    res.json(out);
  }));

  // ---- dev servers ----
  api.post('/servers/start', A(async (req, res) => {
    const { repo, worktreePath } = req.body || {};
    const feature = servers.featureFor(worktreePath);
    const alloc = servers.allocSlotFor(feature);
    if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    const out = await servers.start(repo, worktreePath, servers.launchOpts(repo, feature));
    await refreshRunning();
    broadcastTopology();
    res.json(out);
  }));
  api.post('/servers/stop', A(async (req, res) => {
    const { repo, worktreePath } = req.body || {};
    const out = await servers.stop(repo, worktreePath);
    await refreshRunning();
    // only free the feature's slot once no sibling repo of the feature is still running
    const feature = servers.featureFor(worktreePath);
    if (![...runningCache.keys()].some((p) => servers.featureFor(p) === feature)) servers.releaseSlot(feature);
    broadcastTopology();
    res.json(out);
  }));
  api.post('/servers/restart', A(async (req, res) => {
    const { repo, worktreePath } = req.body || {};
    const feature = servers.featureFor(worktreePath);
    const alloc = servers.allocSlotFor(feature); // reuse the feature's slot across the restart
    if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    const out = await servers.restart(repo, worktreePath, servers.launchOpts(repo, feature));
    await refreshRunning();
    broadcastTopology();
    res.json(out);
  }));
  api.get('/servers/logs', (req, res) => {
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
    res.json(servers.logs(req.query.worktreePath, { offset }));
  });

  // ---- feature/group orchestration (run whole stack · stop & switch) ----
  orchestrator.register(api, {
    cfg, servers, manager, repos: () => repos, resolveGroup, conflictsFor, refreshRunning, scheduleBroadcast: broadcastTopology, rescan,
  });

  // GET /sessions/:id/ci (still an on-demand answer for SwiftBar/Alfred and any
  // external caller) + POST /group/pr. Created above, next to the feed it feeds.
  forge.register(api);

  // Start a session in an existing worktree (Fleet: "Start session here")
  api.post('/worktrees/adopt', A(async (req, res) => {
    const { repo, worktreePath, branch, wtname } = req.body || {};
    if (!worktreePath) return res.status(400).json({ error: 'worktreePath is required' });
    const repoObj = repos.find((r) => r.name === repo);
    if (!repoObj) return res.status(400).json({ error: 'unknown repo' });
    let s = await manager.adopt({ worktreePath, repoName: repo, repoPath: repoObj.path, branch, wtname });
    if (!s) s = manager.sessionForWorktree(worktreePath); // an adopt was already in flight
    broadcastTopology();
    res.json(s || { error: 'session is already being opened' });
  }));

  // ---- editor open ----
  api.post('/open', A(async (req, res) => {
    const { path: p, editor } = req.body || {};
    const ed = (cfg.editors && (cfg.editors[editor] || cfg.editors[cfg.defaultEditor])) || null;
    if (!ed) return res.status(400).json({ error: 'no editor configured' });
    const cmd = ed.open.replace('{path}', shq(p));
    await run('bash', ['-lc', cmd]);
    res.json({ ok: true });
  }));

  require('./transcript-routes').register(app, { manager, cfg });
  require('./routes-review').register(app, { manager, repos: () => repos, broadcast: scheduleBroadcast });

  // ---- Claude Code hook receiver ----
  // Not under /api: the URL is baked into every session's generated settings file.
  // Those files are read once, at claude's launch — so a session that was already
  // running when this build first started still POSTs a tokenless URL and cannot be
  // told otherwise without killing it. `hookAuth` marks the sessions whose settings
  // file we have since written *with* a token; anything else is grandfathered in.
  // The exemption is narrow (this route only sets a session's state/activity string)
  // and self-clearing (activate/restore rewrites the file and sets the flag).
  app.post('/hook/:event', (req, res) => {
    const id = req.query.wts;
    const known = id ? manager.get(id) : null;
    const deny = guard.denyToken(req);
    if (deny && !(known && known.hookAuth !== true)) return res.status(deny.status).json({ error: deny.error });
    let payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = { raw: payload }; } }
    if (id) manager.applyHook(id, req.params.event, payload || {});
    res.json({ ok: true });
  });

  // ---- HTTP + WS ----
  const server = http.createServer(app);

  // noServer + a hand-written upgrade handler, not `{ server }`: the checks have to
  // run and the socket has to be destroyed BEFORE ws accepts the handshake and this
  // module's connection handler spawns a pty. WebSockets are exempt from CORS, so
  // the Origin check here is the only thing standing between an open browser tab on
  // any site and a read/write shell in the user's tmux.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/ws/term') { socket.destroy(); return; }
    const deny = guard.denyBrowser(req) || guard.denyToken(req, url.searchParams.get('token'));
    if (deny) {
      // A plain HTTP response, then close: the client never reaches ws state OPEN, so
      // it sees a failed handshake rather than a socket that opens and dies.
      socket.write(`HTTP/1.1 ${deny.status} ${deny.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('session');
    const pane = url.searchParams.get('pane');
    const cols = Number(url.searchParams.get('cols')) || 100;
    const rows = Number(url.searchParams.get('rows')) || 30;
    const s = manager.get(id);
    if (!s) { ws.close(); return; }
    // The split pane attaches to the standalone `-split` session — a separate terminal
    // in the same worktree with its own tabs. Ensure it exists before the pty attaches.
    if (pane === 'split') { try { await manager.mux.ensureSplit(s.muxName, { cwd: s.worktreePath || s.repoPath }); } catch { /* */ } }
    const spec = manager.mux.attachSpawn(s.muxName, pane === 'split' ? { group: 'split' } : {});
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
  // Crash policy lives in server/crash.js: fatal by default, with one narrow
  // exemption for errors confined to an already-dead client socket.
  crash.install();
  // A failed bind has to kill the process. Without this the 'error' event has no
  // listener, Node re-throws it, and the daemon runs on with no HTTP server.
  crash.guardListen(server, { host: cfg.web.host, port: cfg.web.port });
  await watchMod.start({ cfg, rescan, refreshRunning, reconcile: () => manager.reconcile(), hasViewers: attention.active });
  const restored = await manager.restore().catch(() => 0);
  if (restored) console.log(`[wt-studio] restored ${restored} session(s)`);

  server.listen(cfg.web.port, cfg.web.host, () => {
    console.log(`[wt-studio] http://${cfg.web.host}:${cfg.web.port}  (${repos.length} repos, mux=${mux ? mux.name : 'none'})`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
