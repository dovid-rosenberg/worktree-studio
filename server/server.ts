import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import * as gitMod from './git.ts';
import * as watchMod from './watch.ts';
import * as worktree from './worktree.ts';
const { worktreeCopyOpts } = worktree;
import * as review from './review.ts';
import * as sources from './sources/index.ts';
import * as asana from './sources/asana.ts';
import { SessionManager } from './sessions.ts';
import { Servers } from './servers.ts';
import { createIdentity } from './identity.ts';
import { createState } from './state.ts';
import { createBroadcast } from './broadcast.ts';
import { createForge } from './forge.ts';
import { createCiFeed } from './ci.ts';
import { createTaskStatusFeed } from './task-status.ts';
import * as orchestrator from './orchestrator.ts';
import { createGuard } from './security.ts';
import { createTerminalHandler } from './term.ts';
import { createRescan } from './rescan.ts';
import { attachableWorktrees } from './features.ts';
import * as runConfigs from './run-configs.ts';
// isRecord too: this file had a byte-identical copy, docstring included, of a
// predicate settings.ts already exported — and already imports four symbols from.
import { coerceEditors, coerceGroups, coerceRunConfigs, coerceStart, isRecord } from './settings.ts';
import { Runner } from './runner.ts';
import * as webui from './webui.ts';
import * as crash from './crash.ts';
import { run, has, openEditor, qs, realpath, resolveEditor, shq, slug, expandTilde } from './util.ts';
import * as configMod from './config.ts';
import tmux, { reapLaunchScripts } from './multiplexer/tmux.ts';
import * as transcriptRoutes from './transcript-routes.ts';
import * as routesReview from './routes-review.ts';
import * as reinstate from './reinstate.ts';
import * as layoutMod from './layout.ts';
import type { ScannedRepo } from './git.ts';
import { FEATURE_COLORS } from './types.ts';
import type { Session, SessionRepo } from './types.ts';
import * as startReport from './start-report.ts';
import fs from 'fs';

/** A thrown value's message. `catch` binds `unknown`, and not everything thrown is an Error. */
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * A session repo that has been promoted. Everything that starts, stops or slots a
 * dev server needs the worktree path, and `SessionRepo.worktreePath` is null until
 * promote() runs — so the filter that drops the unpromoted ones says so in the type.
 */
type PromotedRepo = SessionRepo & { worktreePath: string };
const promoted = (r: SessionRepo): r is PromotedRepo => !!r.worktreePath;

/** The POST /settings body. Every field is `unknown` until it has been checked. */
interface SettingsBody {
  sources?: unknown;
  runConfigs?: unknown;
  baseDirs?: unknown;
  notify?: unknown;
  start?: unknown;
  editors?: unknown;
  defaultEditor?: unknown;
  groups?: unknown;
}

async function main() {
  const cfg = configMod.load();
  // Was `muxSelect.select()` in an 11-line module that returned tmux-or-null — and
  // server.ts imported tmux directly as well, so the indirection was already bypassed.
  const mux = (await tmux.available()) ? tmux : null;
  if (!mux) {
    console.error('[wt-studio] tmux not found — install it (brew install tmux) and retry.');
  } else {
    console.log(`[wt-studio] multiplexer: ${mux.name}`);
  }

  // One feature-identity resolver for the whole process: state.ts groups worktrees
  // with it, servers.ts keys concurrency slots with it and sessions.ts records it
  // on each session, so none of the three can drift.
  const identity = createIdentity(cfg);
  const manager = new SessionManager(cfg, mux || tmux, identity);
  const servers = new Servers(cfg, identity);
  // Finite commands (tests, builds) — tracked with a status, a duration and an exit code
  // rather than left in a terminal pane. See server/runner.ts for why it is not Servers.
  const runner = new Runner(cfg._stateDir!);

  // ---- repo scan cache ----
  let repos: ScannedRepo[] = [];
  // One scan at a time, and a request that arrives mid-scan is QUEUED rather than
  // dropped — see server/rescan.ts for the caller (POST /api/settings changing
  // baseDirs) that nothing on the filesystem would ever have re-triggered.
  const rescan = createRescan(async () => {
    try {
      repos = await gitMod.scan(cfg.baseDirs, cfg.scanDepth);
    } catch (e) {
      /*
       * The previous scan stands rather than the list going empty — but SAY SO. This
       * swallowed silently, so POST /settings with a mistyped baseDir echoed the new
       * dirs back with ok:true while the topology kept serving the old repos, and
       * nothing anywhere connected the two.
       */
      console.error(`[wt-studio] repo scan failed, keeping the previous ${repos.length} repo(s):`, e);
    }
    // The scan is the only thing that knows each worktree's branch, and the
    // branch/manifest identity strategies need it to answer from a path alone.
    identity.reindex(repos);
    prunePaths(); // the fresh scan is what says which worktrees still exist
    broadcastTopology(); // the scan IS the topology
    // A scan is also the server's only notice that git moved. watch.ts arms
    // fs.watch on `.git/refs` (recursive), so a commit writes refs/heads/<branch>,
    // a push writes refs/remotes/origin/<branch>, and a branch switch writes HEAD —
    // each lands here. Those are precisely the three local events that change what
    // `gh pr view` would answer, so this is the CI feed's main trigger. Fire and
    // forget: the feed debounces, floors and gates it, and nothing here waits.
    ciFeed.poke({ force: true });
  });

  // Cached lsof discovery — refreshed on a timer and after mutations, not on
  // every SSE broadcast (which fires per Claude hook → per tool call).
  let runningCache = new Map();
  let runningSig = '';
  async function refreshRunning() {
    try {
      runningCache = await servers.discoverRunning();
      servers.reconcileSlots(runningCache); // self-heal leaked/stale slots against reality
      // Drop records whose process is gone. This used to run at boot ONLY, so a dev
      // server that died on its own — crashed, or killed from a terminal — left a
      // tracked record for the rest of the daemon's lifetime: the strip kept claiming
      // it was up until someone restarted the app. pruneTracked writes only when it
      // actually drops something, so on the common path this is a pid check per
      // tracked worktree and nothing else.
      if ((await servers.pruneTracked()).length) runningSig = '';
    } catch {
      return;
    }
    // Nothing else bounds a dev server that has been running for days without a
    // restart: it appends to its log the whole time, and only a sweep is ever going
    // to notice. One stat per tracked worktree (see Servers.trimLogs). Outside the
    // guard above so a failure here can't masquerade as a failed lsof discovery.
    servers.trimLogs();
    // Discovery feeds the topology half (each worktree's running/ports), so a new
    // or vanished server has to push one — but only when what lsof found actually
    // changed, or this 3 s timer would re-send the slow half 20 times a minute.
    const sig = [...runningCache]
      .map(([p, v]) => `${p}:${(v.ports || []).join(',')}`)
      .sort()
      .join('|');
    if (sig === runningSig) return;
    runningSig = sig;
    broadcastTopology();
  }

  // The state payload lives in state.ts; both caches above are handed over as
  // getters because each is replaced (not mutated) on every refresh.
  const { buildState, topology, sessionState, ciSubjects, prunePaths, resolveGroup, conflictsFor } = createState({
    cfg,
    manager,
    servers,
    mux,
    identity,
    repos: () => repos,
    running: () => runningCache,
    runs: () => runner.runs,
  });

  // ---- SSE live state ----
  // Two named event types with very different rates (see broadcast.ts).
  // scheduleBroadcast() sends the small session half only — that is what every
  // Claude hook gets. broadcastTopology() adds the slow half and is called by the
  // handful of things that can actually change the repo → worktree shape (a git
  // rescan, a worktree/session mutation, dev-server discovery, a config save).
  // ---- PR/MR + CI status (serverbar pill) ----
  // Pushed, not polled. Three objects that each only reach the next one at call
  // time: the forge does the lookups and tells the feed when it opened a PR, the
  // feed owns the snapshot and decides when to look, the bus carries the result.
  const forge = createForge({ cfg, manager, resolveGroup, onChanged: () => ciFeed.poke({ force: true }) });
  const ciFeed = createCiFeed({
    forge,
    // Every worktree of each session's FEATURE, not just the repos the session owns —
    // see state.ciSubjects(). A worktree created with `wt` rather than through Studio
    // belongs to the feature immediately and to the session never, and the chips are
    // drawn from the feature.
    sessions: ciSubjects,
    streams: () => bus.clients.size, // an SSE subscriber is the only thing a `ci` frame can reach
    onChange: () => bus.schedule({ ci: true }),
  });

  /*
   * Ticket status — the one part of a link that needs an API rather than a pattern.
   *
   * Refreshed alongside CI because they are the same KIND of thing: external state on
   * somebody else's server, pulled on a long timer. It rides the `ci` frame for the same
   * reason. With no tracker token configured this resolves nothing and costs nothing.
   */
  const taskFeed = createTaskStatusFeed({ cfg });
  const refreshTaskStatus = async () => {
    const feats = Object.entries(cfg.featureLinks || {})
      .filter(([, v]) => v?.ticket)
      .map(([name, v]) => ({ name, ticket: v.ticket }));
    if (await taskFeed.refresh(feats)) bus.schedule({ ci: true });
  };

  const bus = createBroadcast({
    topology,
    sessionState,
    ci: () => ({ ...ciFeed.snapshot(), taskStatus: taskFeed.snapshot() }),
  });
  // A run starting or finishing is a real state change and a rare one — unlike the hook
  // stream, this cannot flood the fan-out.
  runner.on('change', () => bus.schedule({}));
  const scheduleBroadcast = () => bus.schedule();
  const broadcastTopology = () => bus.schedule({ topology: true });

  // Paces the watcher's sweeps. Only the browser subscribes to /api/events — SwiftBar
  // polls /api/state every 10s and Alfred once per keystroke — so a recent poll has to
  // count as "someone is looking" too, or the menubar's server dots go minutes stale.
  const attention = watchMod.attention({ streams: () => bus.clients.size });
  manager.on('change', scheduleBroadcast);

  // ---- express ----
  const app = express();

  // Everything below sits behind the Host/Origin allowlist — see security.ts for
  // what each gate stops. It runs before the body parsers so a rejected request is
  // never given the chance to make us buffer 8 MB of its JSON.
  const guard = createGuard({ cfg, token: cfg._token });
  app.use(guard.browser);

  app.use(express.json({ limit: '8mb' }));
  app.use(express.text({ type: 'text/*', limit: '8mb' }));

  // The browser tab cannot be handed a header before it exists, so the boot token is
  // injected into the one document we hand it. That is safe precisely because of the
  // gate above: a cross-origin page cannot read this response body, and a rebinding
  // page is refused before there is a body to read. See webui.ts for which UI this is
  // which UI this is; its SPA fallback is mounted after every route below.
  // A UI that isn't on disk is a boot failure, not a 404 the user has to reverse-
  // engineer: say what is missing and how to get it, and stop.
  let ui: webui.ResolvedUi;
  try {
    ui = webui.resolve();
  } catch (e) {
    console.error(`[wt-studio] ${msg(e)}`);
    process.exit(1);
  }
  console.log(`[wt-studio] serving the ${ui.label}`);
  webui.mount(app, { ui, token: cfg._token });

  // Every API route needs the boot token. The Origin/Host gate above only constrains
  // browsers; this is what stops any other local process — or a browser request that
  // carries no Origin at all — from driving the studio. It goes on the /api PREFIX
  // rather than on the router below, so it covers everything served under it however
  // it got there; /api/v1 is nested under /api, so one line covers both prefixes.
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
  api.get('/state', async (_req, res) => {
    attention.seen();
    res.json(await buildState());
  });

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
    // Same reason, and equally cheap: with no ticket configured, or nothing stale, this
    // is a filter over a small object and no request at all.
    void refreshTaskStatus();
    const hb = setInterval(() => {
      try {
        res.write(':hb\n\n');
      } catch {
        /* */
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(hb);
      unsubscribe();
    });
  });

  // ---- settings / connections ----
  api.get('/settings', async (_req, res) => {
    const gh = await run('gh', ['auth', 'status'], {});
    res.json({
      sources: cfg.sources || {},
      baseDirs: cfg.baseDirs || [],
      notify: cfg.notify || {},
      start: cfg.start || {},
      editors: cfg.editors || {},
      defaultEditor: cfg.defaultEditor || '',
      groups: cfg.groups || [],
      // The MANUAL run configurations only; an editor's own are discovered per worktree.
      runConfigs: cfg.runConfigs || {},
      enabled: sources.enabled(cfg),
      tools: { gh: has('gh'), glab: has('glab') },
      githubAuthed: gh.code === 0,
    });
  });
  /*
   * A feature's colour tag. Its OWN route, deliberately not a field on POST /settings.
   *
   * /settings is a full replace for the maps it carries, and the last thing that wrote a
   * single value through it deleted two repos' start commands on the way past. Setting a
   * colour is a one-key write, so it does one-key work: no coercion runs, and nothing the
   * body did not mention can be dropped. An empty colour clears the tag rather than
   * storing a blank, so the map only ever holds live entries.
   */
  api.post('/features/:name/color', async (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'no feature named' });
    const color = String(req.body?.color || '').trim();
    if (color && !(FEATURE_COLORS as readonly string[]).includes(color)) {
      return res.status(400).json({ ok: false, error: `unknown colour: ${color}` });
    }
    cfg.featureColors = { ...(cfg.featureColors || {}) };
    if (color) cfg.featureColors[name] = color;
    else delete cfg.featureColors[name];
    configMod.save(cfg);
    broadcastTopology();
    res.json({ ok: true, color });
  });

  /*
   * A feature's links: its tracker URL and anything pinned by hand.
   *
   * Its own narrow route for the same reason the colour has one — /settings is a full
   * replace for the maps it carries, and the last single value written through it deleted
   * two repos' start commands on the way past.
   *
   * Keyed by FEATURE, deliberately, not by session: a ticket outlives the agent working
   * on it, and `session.sourceUrl` died whenever the session did.
   */
  api.post('/features/:name/links', async (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'no feature named' });
    const body = req.body || {};

    const ticket = typeof body.ticket === 'string' ? body.ticket.trim() : undefined;
    // Every pin needs a url; a label is optional and falls back to the provider's name.
    // Anything without a url is dropped rather than stored as a link to nowhere.
    const pins = Array.isArray(body.pins)
      ? body.pins
          .filter(isRecord)
          .map((x: Record<string, unknown>) => ({
            label: String(x.label || '').trim(),
            url: String(x.url || '').trim(),
          }))
          .filter((x: { url: string }) => !!x.url)
          .map((x: { label: string; url: string }) => (x.label ? x : { url: x.url }))
      : undefined;

    const next = { ...((cfg.featureLinks || {})[name] || {}) };
    if (ticket !== undefined) {
      if (ticket) next.ticket = ticket;
      else delete next.ticket;
    }
    if (pins !== undefined) {
      if (pins.length) next.pins = pins;
      else delete next.pins;
    }

    cfg.featureLinks = { ...(cfg.featureLinks || {}) };
    // An entry with nothing left in it is removed, so the map only holds live values.
    if (Object.keys(next).length) cfg.featureLinks[name] = next;
    else delete cfg.featureLinks[name];

    configMod.save(cfg);
    broadcastTopology();
    res.json({ ok: true, links: next });
  });

  api.post('/settings', async (req, res) => {
    // Every field is `unknown`: a JSON body can carry anything, so nothing here is a
    // string, an object or an array until it has been checked — the same rule
    // server/orchestrator.ts's GroupBody follows.
    const body: SettingsBody = req.body || {};
    const {
      sources: srcs,
      baseDirs,
      notify,
      start,
      editors,
      defaultEditor,
      groups,
      runConfigs: runCfgs,
    } = body;
    if (isRecord(srcs)) {
      cfg.sources = cfg.sources || {};
      for (const k of Object.keys(srcs)) {
        const prev = cfg.sources[k];
        cfg.sources[k] = { ...(isRecord(prev) ? prev : {}), ...(isRecord(srcs[k]) ? srcs[k] : {}) };
      }
    }
    if (isRecord(notify)) {
      cfg.notify = { ...(cfg.notify || {}), ...notify };
    }
    let rescanNeeded = false;
    let missingDirs: string[] = [];
    if (Array.isArray(baseDirs)) {
      cfg.baseDirs = baseDirs.map((s) => expandTilde(String(s).trim())).filter(Boolean);
      /*
       * A directory that does not exist is REPORTED, not silently accepted.
       *
       * The save answered ok:true and echoed the new dirs back, the scan then found
       * nothing there, and the dashboard emptied — with the three facts connected
       * nowhere. A typo in a path is the single most likely thing to go wrong in this
       * form, and it looked exactly like a successful save.
       *
       * Saved anyway rather than rejected: the directory may be on a volume that is not
       * mounted right now, and refusing the whole save over one row would be worse.
       */
      missingDirs = cfg.baseDirs.filter((d) => !fs.existsSync(d));
      rescanNeeded = true;
    }
    // Dev-server launch config { "<repo>": { cmd, ports:[…] } } — full replace, drop blank rows.
    if (isRecord(start)) {
      cfg.start = coerceStart(start);
      rescanNeeded = true;
    }
    /*
     * Hand-written run configurations, `{ "<repo>": [{ name, cmd, kind }] }` — full
     * replace, blank rows dropped, exactly as `start` and `editors` are handled.
     *
     * These are the MANUAL half only. Whatever an editor declares in a worktree is
     * discovered live (server/run-configs.ts) and is not stored here, so saving this
     * cannot delete a config that came from a file.
     */
    if (isRecord(runCfgs)) cfg.runConfigs = coerceRunConfigs(runCfgs);
    // Editors { "<name>": { open, openGroup? } } — full replace, drop blank rows.
    if (isRecord(editors)) cfg.editors = coerceEditors(editors);
    if (typeof defaultEditor === 'string' && defaultEditor.trim()) cfg.defaultEditor = defaultEditor.trim();
    // Manual feature groups [{ name, members:[…] }] — full replace, drop blank rows.
    if (Array.isArray(groups)) cfg.groups = coerceGroups(groups);
    configMod.save(cfg);
    if (rescanNeeded) await rescan();
    else broadcastTopology();
    res.json({
      ok: true,
      // Present only when something is wrong, so the quiet path stays quiet.
      ...(missingDirs.length ? { warnings: [`these folders do not exist: ${missingDirs.join(', ')}`] } : {}),
      sources: cfg.sources,
      baseDirs: cfg.baseDirs,
      runConfigs: cfg.runConfigs,
      notify: cfg.notify,
      start: cfg.start,
      editors: cfg.editors,
      defaultEditor: cfg.defaultEditor,
      groups: cfg.groups,
      enabled: sources.enabled(cfg),
    });
  });

  // ---- sources ----
  api.get('/sources', (_req, res) => res.json(sources.enabled(cfg)));
  /*
   * Check a token the user has just typed, and report who it belongs to.
   *
   * Takes the token in the BODY rather than reading config, because it is asked BEFORE
   * anything is saved — proving the token works is what the user is doing when they press
   * Connect. Nothing is persisted here.
   */
  api.post('/sources/asana/verify', async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: 'a token is required' });
    try {
      res.json({ ok: true, ...(await asana.verify(token)) });
    } catch (e) {
      // Asana answers 401 for a bad token, which is much the commonest thing to get wrong.
      const m = msg(e);
      res.status(400).json({
        ok: false,
        error: /401/.test(m) ? 'Asana rejected that token' : m,
      });
    }
  });
  api.get('/sources/:source/items', async (req, res) => {
    const repo = repos.find((r) => r.name === req.query.repo);
    const out = await sources.list(cfg, req.params.source, { repoPath: repo?.path, q: req.query.q });
    res.json(out);
  });

  // ---- sessions ----
  api.post('/sessions', async (req, res) => {
    try {
      const { source, sourceId, text, name, repo, additionalRepos } = req.body || {};
      const repoObj = repos.find((r) => r.name === repo);
      if (!repoObj) return res.status(400).json({ error: `unknown repo '${repo}'` });
      const seed = await sources.seed(cfg, source || 'freetext', {
        repoPath: repoObj.path,
        id: sourceId,
        text,
        name,
      });
      const extra = (Array.isArray(additionalRepos) ? additionalRepos : [])
        .map((rn: unknown) => repos.find((r) => r.name === rn))
        .filter((r): r is ScannedRepo => !!r)
        .map((r) => ({ repo: r.name, repoPath: r.path }));
      const session = await manager.create({
        seed,
        repoPath: repoObj.path,
        repoName: repoObj.name,
        additionalRepos: extra,
      });
      res.json(session);
    } catch (e) {
      res.status(500).json({ error: msg(e) });
    }
  });

  api.post('/sessions/:id/rename', async (req, res) => {
    res.json(await manager.rename(req.params.id, req.body?.title || ''));
  });
  // Kill the mux session and relaunch it, keeping the conversation — see restartTerminal.
  api.post('/sessions/:id/restart-terminal', async (req, res) => {
    const out = await manager.restartTerminal(req.params.id);
    res.json(out);
  });
  api.post('/sessions/:id/deactivate', async (req, res) => {
    res.json(await manager.deactivate(req.params.id));
  });
  api.post('/sessions/:id/activate', async (req, res) => {
    res.json(await manager.activate(req.params.id));
  });

  /** Feature worktrees this session has no record of — see features.ts for why. */
  const attachableFor = (s: Session | undefined) =>
    attachableWorktrees(
      repos,
      s?.feature,
      new Set((s?.repos || []).map((r: SessionRepo) => r.repoPath)),
      (i) => identity.of(i),
    );

  // Add a repo to a session's feature (creates a same-named worktree + grants access).
  // Used by the UI button and the `wt-studio add-repo` CLI (David or claude).
  api.post('/sessions/:id/add-repo', async (req, res) => {
    const repoObj = repos.find((r) => r.name === req.body?.repo);
    if (!repoObj) return res.status(400).json({ error: `unknown repo '${req.body?.repo}'` });
    const out = await manager.addRepo(req.params.id, { repo: repoObj.name, repoPath: repoObj.path });
    if (!out.ok) return res.status(400).json(out);
    await rescan(); // pick up the sibling worktree so the feature updates immediately
    res.json(out);
  });

  api.post('/sessions/:id/promote', async (req, res) => {
    const out = await manager.promote(req.params.id, req.body || {});
    // Dirty-main warning: 200 (not 400) so the client can read needsConfirm and re-prompt.
    if (out.needsConfirm) return res.json(out);
    if (!out.ok) return res.status(400).json(out);
    await rescan(); // pick up the new worktree(s) so features update immediately
    /*
     * The ticket becomes the FEATURE's, at the one moment a session becomes a feature.
     *
     * `assemble()` also falls back to `session.sourceUrl`, so the chip renders without
     * this — but only for as long as the session exists, and the whole point of keying
     * links by feature is that they outlive the agent. Copying it here is the moment
     * that has a feature to copy it to. Never overwrites: a ticket the user set by hand
     * outranks the one intake guessed.
     */
    const promotedSession = manager.get(req.params.id);
    const wtName = promotedSession?.worktree;
    if (wtName && promotedSession?.sourceUrl) {
      const existing = (cfg.featureLinks || {})[wtName];
      if (!existing?.ticket) {
        cfg.featureLinks = { ...(cfg.featureLinks || {}) };
        cfg.featureLinks[wtName] = { ...(existing || {}), ticket: promotedSession.sourceUrl };
        configMod.save(cfg);
      }
    }
    /*
     * Feature membership and SESSION membership are two different records, and nothing
     * kept them in step. A feature groups worktrees by identity; a session's `repos` is
     * what the agent was granted with /add-dir. Promote into a feature whose other
     * worktrees were made outside Studio (a plain `wt`), and the feature card shows
     * every repo while the session knows only its own — so Changes, which is
     * session-scoped, renders an empty diff of a genuinely empty worktree, and the
     * agent cannot write to the repos it was started for.
     *
     * Report the gap rather than closing it silently: attaching sends /add-dir into a
     * live session, which is the user's call.
     */
    res.json({ ...out, attachable: attachableFor(out.session) });
  });

  api.post('/sessions/:id/tabs', async (req, res) => {
    res.json(await manager.addTab(req.params.id, req.body || {}));
  });

  // `tab` is the multiplexer window id; `index` is the legacy positional form, kept so
  // an older client keeps working. The manager resolves either.
  api.post('/sessions/:id/select-tab', async (req, res) => {
    const b = req.body || {};
    res.json(await manager.selectTab(req.params.id, b.tab ?? b.index ?? 0));
  });

  api.post('/sessions/:id/rename-tab', async (req, res) => {
    const b = req.body || {};
    res.json(await manager.renameTab(req.params.id, b.tab ?? b.index ?? 0, b.title));
  });

  api.post('/sessions/:id/close-tab', async (req, res) => {
    const b = req.body || {};
    res.json(await manager.closeTab(req.params.id, b.tab ?? b.index ?? 0));
  });

  // Start / stop ALL dev servers of a session's shared workspace (every repo it owns).
  api.post('/sessions/:id/servers/start', async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    /*
     * The same judgement /group/start makes, from the same module.
     *
     * This route was the third, unfixed copy of it, and it carried every defect the
     * group route was hardened against: it filtered on `startCfg` (a start command
     * EXISTS) rather than `canStart` (starting will WORK), so it launched into a
     * worktree with no node_modules and the command died on the spot; it never named
     * the repos it declined to launch; it answered `some(r.ok)`, so one repo of three
     * was a success; and it never looked at `listening`, so a process that spawned and
     * bound nothing counted as up. Pressing this button reproduced, exactly, the
     * "the BE does not seem to be running" report that /group/start was fixed for.
     */
    const owned = (s.repos || []).filter(promoted).map((r) => ({
      repo: r.repo,
      path: r.worktreePath,
      ...servers.decorate({ repo: r.repo, path: r.worktreePath }, runningCache),
    }));
    const skipped = startReport.toSkip(owned);
    const launch = startReport.toStart(owned);
    // Slot keys come from the per-worktree feature identity (server/identity.ts) inside
    // startAll — the one canonical key used everywhere.
    const out = await servers.startAll(launch.map((m) => ({ repo: m.repo, worktreePath: m.path })));
    if (!out.ok) return res.status(409).json({ ok: false, error: out.slotError });
    await refreshRunning();
    broadcastTopology();
    res.json({ ...startReport.report(out.results, skipped), results: out.results });
  });
  api.post('/sessions/:id/servers/stop', async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    const owned = (s.repos || []).filter(promoted);
    for (const r of owned) await servers.stop(r.repo, r.worktreePath);
    // Refresh BEFORE releasing: the guard reads what is still listening, so it has to see
    // the world after the stops. A session's repos can be a strict subset of its feature's
    // members, so "I stopped mine" is not "the feature is down" — see releaseSlotIfIdle.
    await refreshRunning();
    for (const r of owned) servers.releaseSlotIfIdle(servers.featureFor(r.worktreePath), runningCache);
    broadcastTopology();
    res.json({ ok: true });
  });

  api.delete('/sessions/:id', async (req, res) => {
    // Capture the session BEFORE close (close deletes it). Mirror /api/group/delete's
    // orphan cleanup: stop each owned worktree's dev servers + release its slot, else a
    // running server is orphaned and its concurrency slot leaks.
    const s = manager.get(req.params.id);
    const owned: PromotedRepo[] = s ? (s.repos || []).filter(promoted) : [];
    for (const r of owned) await servers.stop(r.repo, r.worktreePath);
    const out = await manager.close(req.params.id, { kill: req.query.kill !== 'false' });
    if (owned.length) {
      await refreshRunning(); // the guard below reads the post-stop world
      for (const r of owned) servers.releaseSlotIfIdle(servers.featureFor(r.worktreePath), runningCache);
      broadcastTopology();
    }
    res.json(out);
  });

  // A repo's default branch, or 'main' when the scan cache doesn't know it — the same
  // fallback server/routes-review.ts uses, and the one git.ts already guarantees for
  // a repo it HAS scanned. Only a repo absent from the cache reaches the literal.
  const defaultBranchOf = (name: string): string =>
    repos.find((r) => r.name === name)?.defaultBranch || 'main';

  // ---- review (commits, per-commit diffs & commit) ----
  // The branch's commits per repo (+ an uncommitted summary), and one commit's inline
  // per-file diffs on demand.
  /*
   * The same rollup for a FEATURE rather than a session.
   *
   * /sessions/:id/commits is keyed on a session, so a feature with no agent — the exact
   * case the dock's feature pane exists for — could not answer "what is in here, and is
   * it merged?" without starting one. Same shape, so the client renders both the same
   * way.
   */
  /**
   * One repo's review rollup: its commits, its base, and what is uncommitted.
   *
   * Extracted because `/group/:name/commits` and `/sessions/:id/commits` were two copies
   * of the same 25 lines that differed only in where they got the path from — so a fix
   * to one (a vanished worktree being reported as a clean empty review) had to be applied
   * to both, or one of them would go on lying.
   */
  async function reviewRollup(repo: string, worktreePath: string, branch?: string | null) {
    /*
     * A worktree that is gone is REPORTED, not reviewed as empty.
     *
     * util.git() returns '' for any non-zero exit, including a missing cwd — so every git
     * call quietly answered nothing and the response was byte-for-byte identical to a
     * healthy branch with no changes: zero commits, zero files, and a fabricated `base`
     * that no command had produced. If your work was in that worktree, the Review pane
     * told you everything was fine and empty.
     */
    if (!fs.existsSync(worktreePath)) {
      return {
        repo,
        worktreePath,
        branch,
        error: 'this worktree is no longer on disk',
        commits: [],
        uncommitted: { fileCount: 0, added: 0, deleted: 0 },
      };
    }
    const def = defaultBranchOf(repo);
    const { base, commits } = await review.commits(worktreePath, def);
    const wc = await review.working(worktreePath);
    return {
      repo,
      worktreePath,
      branch,
      base,
      defaultBranch: def,
      commits,
      uncommitted: {
        fileCount: wc.files.length,
        added: wc.files.reduce((n, f) => n + (f.added || 0), 0),
        deleted: wc.files.reduce((n, f) => n + (f.deleted || 0), 0),
      },
    };
  }

  api.get('/group/:name/commits', async (req, res) => {
    const { group: g } = await resolveGroup(String(req.params.name || ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const out = [];
    for (const m of g.members) {
      if (!m.path) continue;
      out.push(await reviewRollup(m.repo, m.path, m.branch));
    }
    res.json({ repos: out });
  });

  api.get('/sessions/:id/commits', async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    const out = [];
    for (const entry of s.repos || []) {
      if (!entry.worktreePath) continue;
      out.push(await reviewRollup(entry.repo, entry.worktreePath, entry.branch));
    }
    res.json({ repos: out });
  });

  api.get('/sessions/:id/commit-detail', async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'no such session' });
    const entry = (s.repos || []).find((r) => r.repo === qs(req.query.repo));
    if (!entry?.worktreePath) return res.status(400).json({ error: 'unknown repo or no worktree' });
    const sha = qs(req.query.sha) || 'uncommitted';
    // Same boundary check as routes-review.ts: `sha` reaches a git argv, so it has
    // to be an object name and not an option (see server/review.ts).
    if (!review.isValidSha(sha))
      return res.status(400).json({ error: 'sha must be a hex object name or "uncommitted"' });
    res.json(await review.commitDetail(entry.worktreePath, defaultBranchOf(entry.repo), sha));
  });

  api.post('/sessions/:id/commit', async (req, res) => {
    const s = manager.get(req.params.id);
    const { repo, message, paths, amend } = req.body || {};
    if (!s) return res.status(400).json({ error: 'no such session' });
    const entry = (s.repos || []).find((r) => r.repo === repo);
    if (!entry?.worktreePath) return res.status(400).json({ error: 'unknown repo or no worktree' });
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
    const out = await review.commit(entry.worktreePath, message, { amend, paths });
    // A commit made through the UI writes refs/heads/<branch>, so the watcher would
    // find it anyway — but it can take a debounce plus a scan to get here, and we
    // already know. Poke directly rather than wait to be told what we just did.
    if (out.ok) {
      broadcastTopology();
      ciFeed.poke({ force: true });
    }
    res.json(out);
  });

  // ---- worktrees (manual) ----
  api.post('/worktrees', async (req, res) => {
    const { repo, branch, name } = req.body || {};
    if (!branch && !name) return res.status(400).json({ error: 'branch or name is required' });
    const repoObj = repos.find((r) => r.name === repo);
    if (!repoObj) return res.status(400).json({ error: 'unknown repo' });
    // `name` alone is a documented request (the guard above accepts it), but an absent
    // branch reached `git worktree add -b undefined` and created a branch literally
    // named "undefined". Name-only means "branch after the name".
    const out = await worktree.create(repoObj.path, branch || slug(name), name, {
      layout: identity.layout,
      ...worktreeCopyOpts(cfg, repo),
    });
    await rescan();
    res.json(out);
  });

  api.delete('/worktrees', async (req, res) => {
    const { repo, worktreePath, branch, deleteBranch, force } = req.body || {};
    const repoObj = repos.find((r) => r.name === repo);
    if (!repoObj) return res.status(400).json({ error: 'unknown repo' });
    // Its three siblings all guard this; this one passed the value straight into a git
    // argv, so an omitted field became the literal string "undefined" in an error that
    // was then reported with a 200.
    if (!worktreePath || typeof worktreePath !== 'string') {
      return res.status(400).json({ ok: false, error: 'worktreePath is required' });
    }
    const out = await worktree.remove(repoObj.path, worktreePath, { branch, deleteBranch, force: !!force });
    await rescan();
    res.json(out);
  });

  // ---- dev servers ----
  // Install a worktree's dependencies. Long-running by nature — the response is the
  // OUTCOME, not an acknowledgement, so the client can report success or the npm exit
  // code rather than guessing from a later sweep.
  api.post('/worktrees/install-deps', async (req, res) => {
    const { worktreePath } = req.body || {};
    if (!worktreePath) return res.status(400).json({ error: 'worktreePath is required' });
    const r = await servers.installDeps(String(worktreePath));
    // The worktree's canStart/depsMissing just changed, so push the topology half.
    await refreshRunning();
    broadcastTopology();
    res.json(r);
  });

  api.post('/servers/start', async (req, res) => {
    /*
     * Validate, like every neighbouring route already does.
     *
     * With no body, `startAll` had nothing to start, `results` was empty, and
     * `res.json(undefined)` is a zero-length 200 in express@5 — so a client calling
     * `await r.json()` got a parse error instead of the message. It also skipped the
     * canStart gate that /sessions/:id/servers/start applies, so it would happily launch
     * into a worktree with no dependencies or none at all.
     */
    const repo = String(req.body?.repo || '').trim();
    const worktreePath = String(req.body?.worktreePath || '').trim();
    if (!repo || !worktreePath) {
      return res.status(400).json({ ok: false, error: 'repo and worktreePath are required' });
    }
    const member = {
      repo,
      path: worktreePath,
      ...servers.decorate({ repo, path: worktreePath }, runningCache),
    };
    const skipped = startReport.toSkip([member]);
    if (skipped.length) return res.status(409).json(startReport.report([], skipped));

    const out = await servers.startAll([{ repo, worktreePath }]);
    if (!out.ok) return res.status(409).json({ ok: false, error: out.slotError });
    await refreshRunning();
    broadcastTopology();
    res.json(startReport.report(out.results));
  });
  api.post('/servers/stop', async (req, res) => {
    const repo = String(req.body?.repo || '').trim();
    const worktreePath = String(req.body?.worktreePath || '').trim();
    if (!repo || !worktreePath) {
      return res.status(400).json({ ok: false, error: 'repo and worktreePath are required' });
    }
    const out = await servers.stop(repo, worktreePath);
    await refreshRunning();
    // This route already had the right rule; it is now the shared one (releaseSlotIfIdle).
    servers.releaseSlotIfIdle(servers.featureFor(worktreePath), runningCache);
    broadcastTopology();
    res.json(out);
  });
  api.post('/servers/restart', async (req, res) => {
    const repo = String(req.body?.repo || '').trim();
    const worktreePath = String(req.body?.worktreePath || '').trim();
    if (!repo || !worktreePath) {
      return res.status(400).json({ ok: false, error: 'repo and worktreePath are required' });
    }
    const feature = servers.featureFor(worktreePath);
    const alloc = servers.allocSlotFor(feature); // reuse the feature's slot across the restart
    if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    const out = await servers.restart(repo, worktreePath, servers.launchOpts(repo, feature));
    await refreshRunning();
    broadcastTopology();
    res.json(out);
  });
  api.get('/servers/logs', (req, res) => {
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
    res.json(servers.logs(qs(req.query.worktreePath), { offset }));
  });

  /*
   * ---- run configurations ----
   *
   * DISCOVERED from the worktree on request, not imported and not part of the topology
   * payload. Two reasons: an imported copy goes stale the moment the editor's config
   * changes, and the topology half is broadcast on every git rescan — putting a
   * per-worktree directory scan on that path would cost a handful of stats per worktree
   * per broadcast for something only opened when a menu is.
   *
   * `config.runConfigs[repo]` is merged in as the MANUAL half: anything no editor config
   * can express. Discovered entries win a name clash, since they are the live truth.
   */
  api.get('/run-configs', async (req, res) => {
    const worktreePath = qs(req.query.worktreePath);
    const repo = qs(req.query.repo);
    if (!worktreePath) return res.status(400).json({ error: 'worktreePath is required' });
    const found = await runConfigs.discover(worktreePath, { startCmd: servers.startCfg(repo)?.cmd });
    const names = new Set(found.map((c) => c.name));
    const manual = ((cfg.runConfigs || {})[repo] || [])
      .filter((c) => c && c.name && c.cmd && !names.has(c.name))
      .map((c) => ({ ...c, source: 'manual' as const, file: cfg._file }));
    res.json({ configs: [...found, ...manual] });
  });

  api.get('/runs', (req, res) => {
    const worktreePath = qs(req.query.worktreePath);
    res.json({ runs: worktreePath ? runner.forWorktree(worktreePath) : runner.runs });
  });

  api.get('/runs/:id/log', (req, res) => {
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
    res.json(runner.logs(req.params.id, { offset }));
  });

  api.post('/runs/:id/stop', (req, res) => res.json(runner.stop(req.params.id)));
  api.post('/runs/:id/rerun', (req, res) => res.json(runner.rerun(req.params.id)));
  api.delete('/runs/:id', (req, res) => res.json(runner.remove(req.params.id)));

  api.post('/run-configs/run', async (req, res) => {
    const { repo, worktreePath, name } = req.body || {};
    if (!worktreePath || !name) return res.status(400).json({ error: 'worktreePath and name are required' });

    const found = await runConfigs.discover(String(worktreePath), {
      startCmd: servers.startCfg(String(repo))?.cmd,
    });
    const manual = (cfg.runConfigs || {})[String(repo)] || [];
    const pick = found.find((c) => c.name === name) || manual.find((c) => c && c.name === name);
    if (!pick) return res.status(404).json({ error: `no run configuration named '${name}'` });

    const kind = 'kind' in pick && pick.kind === 'server' ? 'server' : 'task';

    if (kind === 'server') {
      // Long-lived, so it is tracked exactly like a dev server: a pid, a log, and Stop
      // stack reaches it. Only the command differs.
      const feature = servers.featureFor(String(worktreePath));
      const alloc = servers.allocSlotFor(feature);
      if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
      const out = await servers.start(String(repo), String(worktreePath), {
        ...servers.launchOpts(String(repo), feature),
        cmd: pick.cmd,
        // A run config names its own ports nowhere, so there is nothing to pre-check or
        // poll — discovery finds it once it binds.
        ports: [],
        env: { ...(servers.launchOpts(String(repo), feature).env || {}), ...(pick.env || {}) },
      });
      await refreshRunning();
      broadcastTopology();
      return res.json({ ...out, kind });
    }

    /*
     * Finite, so it becomes a RUN: status, duration, exit code, output, history.
     *
     * It used to open a tmux tab. That works, but it makes you read raw ANSI in a pane
     * competing with the agent's tabs, and answers none of the questions you have about a
     * test run. It also needed a session to exist, which a feature may not have — a run
     * needs only a worktree.
     */
    const run = runner.start({
      name: String(name),
      repo: String(repo),
      worktreePath: String(worktreePath),
      cmd: pick.cmd,
      env: pick.env,
    });
    return res.json({ ok: true, kind, runId: run.id });
  });

  // ---- feature/group orchestration (run whole stack · stop & switch) ----
  orchestrator.register(api, {
    cfg,
    // Deleting a feature strips its colour and links, which live in the config file.
    saveConfig: () => configMod.save(cfg),
    servers,
    manager,
    repos: () => repos,
    resolveGroup,
    conflictsFor,
    refreshRunning,
    // A getter, not the Map: refreshRunning() REPLACES runningCache rather than mutating
    // it, so a captured reference would be the pre-refresh map every time.
    running: () => runningCache,
    scheduleBroadcast: broadcastTopology,
    rescan,
  });

  // GET /sessions/:id/ci (still an on-demand answer for SwiftBar/Alfred and any
  // external caller) + POST /group/pr. Created above, next to the feed it feeds.
  forge.register(api);

  // Start a session in an existing worktree (Fleet: "Start session here")
  /*
   * ---- reinstating a closed session ----
   *
   * Closing a session deletes Studio's pointer; the CONVERSATION belongs to Claude Code
   * and stays on disk. These two routes find those orphans and bring one back.
   *
   * Candidates are built HERE rather than in reinstate.ts because only this scope knows
   * the repo scan, the layout and which sessions are live — and because the lookup can
   * only go forwards, from a path to its transcript. The slug is lossy (see reinstate.ts),
   * so walking a transcript directory back to a worktree path is not possible at all.
   */
  async function orphanCandidates() {
    const taken = new Set(
      manager
        .all()
        .flatMap((s) => [s.worktreePath, ...(s.repos || []).map((r) => r.worktreePath)])
        .filter((p): p is string => !!p)
        .map((p) => realpath(p)),
    );
    const out: Array<{
      worktreePath: string;
      repo: string;
      name: string;
      branch: string;
      branchExists: boolean;
      repoPath: string;
    }> = [];

    for (const r of repos) {
      // Worktrees that exist right now and have no session — the common orphan.
      for (const w of r.worktrees || []) {
        if (w.isMain || !w.path || taken.has(realpath(w.path))) continue;
        out.push({
          worktreePath: w.path,
          repo: r.name,
          name: w.name || '',
          branch: w.branch || '',
          branchExists: true, // it is checked out, so it exists by definition
          repoPath: r.path,
        });
      }
      /*
       * And worktrees that are GONE: for every local branch with no worktree, the path one
       * WOULD occupy. Deterministic from the layout, which is what makes this findable at
       * all — the transcript itself cannot be mapped back to a path (the slug is lossy).
       *
       * Enumerated LAZILY, here, rather than added to ScannedRepo: that would put a git
       * call per repo on every scan — which fires whenever a file changes — to answer a
       * question nobody asks until they open this list.
       */
      const raw = await run('git', ['-C', r.path, 'branch', '--format=%(refname:short)']);
      const live = new Set((r.worktrees || []).map((w) => w.path));
      for (const b of raw.stdout
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)) {
        const name = b.split('/').pop() || b;
        const dest = layoutMod.destFor(identity.layout, r.path, name);
        if (live.has(dest) || taken.has(realpath(dest))) continue;
        out.push({ worktreePath: dest, repo: r.name, name, branch: b, branchExists: true, repoPath: r.path });
      }
    }
    return out;
  }

  api.get('/orphans', async (_req, res) => {
    const cands = await orphanCandidates();
    res.json({ orphans: reinstate.findOrphans(cands) });
  });

  /**
   * Bring one back: recreate the worktree if it is missing, then adopt with `--resume`.
   *
   * Refuses rather than improvises when the branch is gone — recreating then would give an
   * empty branch off the default with a transcript attached, i.e. an agent resuming into a
   * directory that does not hold the code it is discussing.
   */
  api.post('/orphans/reinstate', async (req, res) => {
    const worktreePath = String(req.body?.worktreePath || '').trim();
    if (!worktreePath) return res.status(400).json({ ok: false, error: 'worktreePath is required' });

    const cand = (await orphanCandidates()).find((c) => c.worktreePath === worktreePath);
    if (!cand) return res.status(404).json({ ok: false, error: 'nothing to reinstate at that path' });
    const [orphan] = reinstate.findOrphans([cand]);
    if (!orphan)
      return res.status(404).json({ ok: false, error: 'no conversation was found for that worktree' });
    if (!orphan.recoverable) return res.status(409).json({ ok: false, error: orphan.reason });

    if (!fs.existsSync(worktreePath)) {
      // The branch exists — that is what `recoverable` checked — so this checks it out at
      // the path the transcript is keyed to, which is what makes --resume find it.
      const made = await worktree.create(cand.repoPath, cand.branch, cand.name, {
        fetch: false,
        layout: identity.layout,
        ...worktreeCopyOpts(cfg, cand.repo),
      });
      if (!made.ok) return res.status(400).json({ ok: false, error: made.error });
      await rescan();
    }

    const s = await manager.adopt({
      worktreePath,
      repoName: cand.repo,
      repoPath: cand.repoPath,
      branch: cand.branch,
      wtname: cand.name,
      resumeId: orphan.claudeSessionId,
    });
    broadcastTopology();
    if (!s)
      return res.status(409).json({ ok: false, error: 'a session for that worktree is already opening' });
    res.json({ ok: true, session: s });
  });

  api.post('/worktrees/adopt', async (req, res) => {
    const { repo, worktreePath, branch, wtname } = req.body || {};
    if (!worktreePath) return res.status(400).json({ error: 'worktreePath is required' });
    const repoObj = repos.find((r) => r.name === repo);
    if (!repoObj) return res.status(400).json({ error: 'unknown repo' });
    let s = await manager.adopt({ worktreePath, repoName: repo, repoPath: repoObj.path, branch, wtname });
    if (!s) s = manager.sessionForWorktree(worktreePath); // an adopt was already in flight
    broadcastTopology();
    res.json(s || { error: 'session is already being opened' });
  });

  /*
   * ---- editor open ----
   *
   * Takes `path` (one) or `paths` (many). A feature spans several repos, so a session
   * driving it has several worktrees to look at, and this route could only ever open
   * one — the caller's only option was to open the primary and go find the rest by hand.
   *
   * `paths` uses the editor's `openGroup` template when it has one (Zed takes every path
   * as a single workspace) and otherwise loops `open`, which is exactly what
   * /group/open does — WebStorm has no openGroup, so it gets one window per repo.
   */
  api.post('/open', async (req, res) => {
    const { path: p, paths, editor } = req.body || {};
    // Splits "did not name one" from "named one that does not exist" — the old
    // `editors[x] || editors[default]` silently opened the default for a typo.
    const pick = resolveEditor(cfg.editors, editor, cfg.defaultEditor);
    if (!pick.ok) return res.status(400).json({ ok: false, error: pick.error });
    const ed = pick.editor;
    // Dedupe: two repos of one feature are distinct worktrees, but a caller that passed
    // the same path twice must not open two windows on it.
    const list = [
      ...new Set(
        (Array.isArray(paths) ? paths : [p]).filter((x): x is string => typeof x === 'string' && !!x),
      ),
    ];
    if (!list.length) return res.status(400).json({ error: 'path or paths is required' });
    // split/join, not replace(): `$&`/`` $` ``/`$'`/`$$` in a REPLACEMENT string expand
    // after shq() quoted the path, so such a path would open the wrong file.
    const cmds =
      list.length > 1 && ed.openGroup
        ? [ed.openGroup.split('{paths}').join(list.map(shq).join(' '))]
        : list.map((one) => ed.open.split('{path}').join(shq(one)));
    // The exit code, not a hardcoded ok — see openEditor().
    const opened = await openEditor(cmds);
    if (!opened.ok) return res.status(500).json({ ok: false, error: `editor failed: ${opened.error}` });
    res.json({ ok: true, opened: list.length });
  });

  transcriptRoutes.register(api, { manager, cfg });
  routesReview.register(api, { manager, repos: () => repos, broadcast: scheduleBroadcast });

  // ---- Claude Code hook receiver ----
  // Not under /api: the URL is baked into every session's generated settings file.
  // Those files are read once, at claude's launch — so a session that was already
  // running when this build first started still POSTs a tokenless URL and cannot be
  // told otherwise without killing it. `hookAuth` marks the sessions whose settings
  // file we have since written *with* a token; anything else is grandfathered in.
  // The exemption is narrow (this route only sets a session's state/activity string)
  // and self-clearing (activate/restore rewrites the file and sets the flag).
  app.post('/hook/:event', (req, res) => {
    // `?wts=a&wts=b` (or `?wts[x]=y`) hands express an array/object, not a string —
    // same hazard transcript-routes.ts collapses for its query params. Here it made
    // the lookup miss and the hook get dropped in silence. Collapse to the first
    // value, which is what a client sending one session id meant.
    const raw = req.query.wts;
    const id = raw == null ? '' : String(Array.isArray(raw) ? raw[0] : raw);
    const known = id ? manager.get(id) : null;
    const deny = guard.denyToken(req);
    if (deny && !(known && known.hookAuth !== true))
      return res.status(deny.status).json({ error: deny.error });
    let payload = req.body;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = { raw: payload };
      }
    }
    /*
     * A dropped hook says so. This answered ok:true for an empty or unknown `wts`, which
     * is indistinguishable from an applied one — the exact failure mode the array
     * coercion just above was added to fix, left in place one line further down. The
     * session's state simply stops updating and nothing anywhere says why.
     *
     * Still a 200: the hook runs inside the user's claude process and a non-2xx there is
     * noise in their terminal for a condition they cannot act on mid-session. `applied`
     * is for the log and for anyone debugging a card that has gone quiet.
     */
    if (!known) {
      console.warn(
        `[wt-studio] hook ${req.params.event} dropped: ${id ? `unknown session ${id}` : 'no session id'}`,
      );
      return res.json({ ok: true, applied: false, reason: id ? 'unknown session' : 'no session id' });
    }
    manager.applyHook(id, req.params.event, payload || {});
    res.json({ ok: true, applied: true });
  });

  // Client-side routes (/review, /search, /usage) reach the daemon on a deep link or a
  // reload, and the daemon knows nothing about them. Last, so it shadows no route above.
  webui.mountFallback(app, { ui, token: cfg._token });

  // Truly last: the net every route above falls into. express@5 awaits handlers, so a
  // handler that throws — or a body parser that refuses a body — lands here and gets an
  // answer, instead of escaping as the unhandled rejection crash.install() treats as
  // fatal. This is why no handler above needs a wrapper around it.
  app.use(crash.routeErrors());

  // ---- HTTP + WS ----
  const server = http.createServer(app);

  // noServer + a hand-written upgrade handler, not `{ server }`: the checks have to
  // run and the socket has to be destroyed BEFORE ws accepts the handshake and this
  // module's connection handler spawns a pty. WebSockets are exempt from CORS, so
  // the Origin check here is the only thing standing between an open browser tab on
  // any site and a read/write shell in the user's tmux.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url || '', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws/term') {
      socket.destroy();
      return;
    }
    const deny = guard.denyBrowser(req) || guard.denyToken(req, url.searchParams.get('token'));
    if (deny) {
      // A plain HTTP response, then close: the client never reaches ws state OPEN, so
      // it sees a failed handshake rather than a socket that opens and dies.
      socket.write(
        `HTTP/1.1 ${deny.status} ${deny.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', createTerminalHandler({ manager }));

  // ---- boot ----
  // Crash policy lives in server/crash.ts: fatal by default, with one narrow
  // exemption for errors confined to an already-dead client socket.
  crash.install();
  // A failed bind has to kill the process. Without this the 'error' event has no
  // listener, Node re-throws it, and the daemon runs on with no HTTP server.
  crash.guardListen(server, { host: cfg.web.host, port: cfg.web.port });
  // servers.json's tracked pids outlive this process — and reboots, after which the
  // OS starts handing out low pids again. Drop the ones that no longer name a
  // process we launched before anything can use them as a kill target.
  for (const d of await servers.pruneTracked()) {
    console.warn(`[wt-studio] dropped stale tracked pid ${d.pid} for ${d.worktreePath}`);
  }
  // Launch scripts are sourced once, by the shell tmux just started, and are dead weight
  // afterwards — but nothing ever removed them, so they accumulated one per pane per
  // session for the life of the install.
  {
    const reaped = reapLaunchScripts();
    if (reaped) console.log(`[wt-studio] reaped ${reaped} stale launch script(s)`);
  }
  await watchMod.start({
    cfg,
    rescan,
    refreshRunning,
    reconcile: () => manager.reconcile(),
    hasViewers: attention.active,
  });
  // restore() guards each session on its own, so a rejection here means the whole
  // pass went down and NOTHING was relaunched. Discarding the error left that state
  // indistinguishable from "there were no sessions to restore", since the success
  // line below only prints on a non-zero count.
  const restored = await manager.restore().catch((e) => {
    console.error(`[wt-studio] session restore failed — no sessions were relaunched: ${e.message}`, e);
    return 0;
  });
  if (restored) console.log(`[wt-studio] restored ${restored} session(s)`);

  server.listen(cfg.web.port, cfg.web.host, () => {
    console.log(
      `[wt-studio] http://${cfg.web.host}:${cfg.web.port}  (${repos.length} repos, mux=${mux ? mux.name : 'none'})`,
    );
    /*
     * Zero repos is a DEAD END, and it used to be announced as a number.
     *
     * `baseDirs` defaults to `['~/code']`, which its own comment calls "a guess, not a
     * convention" — so on any machine that does not happen to use that layout, a first
     * run boots clean, prints `(0 repos)`, and every surface downstream then implies the
     * user did something wrong: an empty rail, an empty repo dropdown, and `unknown
     * repo ''` if they try anyway. Nothing anywhere names the actual cause, which is a
     * directory that does not exist.
     *
     * Distinguishing the two causes matters: a path that is absent is a different fix
     * (point it somewhere real) from a path that exists and holds no git repos.
     */
    if (!repos.length) {
      const dirs = (cfg.baseDirs || []).map((d) => expandTilde(String(d)));
      const missing = dirs.filter((d) => !fs.existsSync(d));
      console.warn(
        `[wt-studio] no repos found. Studio scans ${dirs.join(', ') || '(nothing — baseDirs is empty)'} ` +
          `${missing.length ? `— ${missing.join(', ')} does not exist. ` : 'and found no git repositories there. '}` +
          `Set your repo folders in Settings, or edit "baseDirs" in ${cfg._file || 'the config file'}.`,
      );
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
