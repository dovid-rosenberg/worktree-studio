/*
 * The express app: every route and every piece of middleware, and nothing else.
 *
 * Split out of server.ts because the two halves have different requirements. Building
 * the collaborators needs a real process — a config file on disk, a state directory, a
 * multiplexer, filesystem watchers, an http server bound to a port, launchd. Building
 * the app needs only those collaborators. Keeping them in one function meant the only
 * way to reach a route was to boot the daemon, so 47 of the 62 routes could not be
 * exercised by a test at all and test/api-routing.test.ts had to assemble a MINIATURE
 * app by hand — which reproduced the mount order from memory and could silently drift
 * from the one the daemon actually has.
 *
 * buildApp() is that mount order, in one place, callable in-process. See
 * test/app-surface.test.ts, which enumerates the routes out of the returned app rather
 * than from a list somebody has to remember to update.
 *
 * THE ORDER BELOW IS LOAD-BEARING. Each step says why it sits where it does; the short
 * version is: the Host/Origin gate before the body parsers, the token on the /api
 * PREFIX so it covers both mounts of the router, /hook outside /api on purpose, and the
 * SPA fallback last because it answers any GET.
 */
import express from 'express';
import * as crash from './crash.ts';
import * as layoutMod from './layout.ts';
import * as orchestrator from './orchestrator.ts';
import * as routesCommits from './routes-commits.ts';
import * as routesHook from './routes-hook.ts';
import * as routesOpen from './routes-open.ts';
import * as routesOrphans from './routes-orphans.ts';
import * as routesReview from './routes-review.ts';
import * as routesSettings from './routes-settings.ts';
import * as routesSources from './routes-sources.ts';
import * as runConfigs from './run-configs.ts';
import { handoff } from './run-handoff.ts';
import * as sources from './sources/index.ts';
import * as startReport from './start-report.ts';
import * as transcriptRoutes from './transcript-routes.ts';
import { qs, realpath, requireBody, requireRepo, requireSession, slug } from './util.ts';
import * as webui from './webui.ts';
import * as worktree from './worktree.ts';
import { attachableWorktrees } from './features.ts';
import type { Response } from 'express';
import type { createForge } from './forge.ts';
import type { ScannedRepo } from './git.ts';
import type { Identity } from './identity.ts';
import type { Runner } from './runner.ts';
import type { RunningServer, Servers } from './servers.ts';
import type { createGuard } from './security.ts';
import type { SessionManager } from './sessions.ts';
import type { State } from './state.ts';
import type { Config, Session, SessionRepo } from './types.ts';

const { worktreeCopyOpts } = worktree;

/** A thrown value's message. `catch` binds `unknown`, and not everything thrown is an Error. */
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * A session repo that has been promoted. Everything that starts, stops or slots a
 * dev server needs the worktree path, and `SessionRepo.worktreePath` is null until
 * promote() runs — so the filter that drops the unpromoted ones says so in the type.
 */
type PromotedRepo = SessionRepo & { worktreePath: string };
const promoted = (r: SessionRepo): r is PromotedRepo => !!r.worktreePath;

/**
 * What the app is built out of.
 *
 * The concrete classes, not narrow structural slices — unlike the individual route
 * modules, which are each typed by the handful of methods they touch so they can be
 * driven by a hand-rolled fake. This is the composition of the whole surface, so
 * nothing would be gained by re-describing SessionManager in terms of the seventeen
 * methods its routes happen to call: a test that builds the real app builds real
 * collaborators against a temp state directory, which is cheap (no subprocess is
 * spawned until a route asks for one) and is the only version that cannot drift.
 *
 * The functions, by contrast, ARE the seam. Every one of them is something the daemon
 * decides and the routes only trigger: what a broadcast means, what a rescan does, what
 * happens when a commit lands. server.ts supplies them.
 */
export interface AppDeps {
  cfg: Config;
  /** Persist cfg. Injected so no route module learns where config.json lives. */
  saveConfig: () => void;
  guard: ReturnType<typeof createGuard>;
  /** The resolved client build. Resolving it can fail the boot, so server.ts does it. */
  ui: webui.ResolvedUi;
  manager: SessionManager;
  servers: Servers;
  runner: Runner;
  identity: Identity;
  forge: ReturnType<typeof createForge>;
  /**
   * The repo scan cache and the lsof discovery map, as getters. Both are REPLACED
   * rather than mutated on every refresh, so a captured reference would be the
   * pre-refresh value for the life of the process.
   */
  repos: () => ScannedRepo[];
  running: () => Map<string, RunningServer>;
  buildState: State['buildState'];
  resolveGroup: State['resolveGroup'];
  conflictsFor: State['conflictsFor'];
  /** bus.subscribe — writes the full snapshot, then joins the client to the fan-out. */
  subscribe: (res: Response) => () => void;
  /** A poll of /state counts as "someone is looking" — see the note on the route. */
  attentionSeen: () => void;
  rescan: () => Promise<unknown>;
  refreshRunning: () => Promise<unknown>;
  /** The slow half of the SSE payload: the repo → worktree → feature shape. */
  broadcastTopology: () => void;
  /** The fast half: the per-session slice every Claude hook moves. */
  scheduleBroadcast: () => void;
  /** Drop a deleted feature from the pulled feeds that are keyed by feature name. */
  forgetFeature: (name: string) => void;
  /**
   * Someone opened an SSE stream. While nobody was subscribed the pulled feeds
   * deliberately did nothing at all, so their snapshots may be stale or empty — this is
   * what makes an opened dashboard fill in within a second rather than at the next
   * safety net.
   */
  onEventsSubscribed: () => void;
  /** A commit landed through the UI: refs moved, so CI and overlap are stale. */
  onCommit: () => void;
}

function buildApp(deps: AppDeps): express.Express {
  const {
    cfg,
    saveConfig,
    guard,
    ui,
    manager,
    servers,
    runner,
    identity,
    forge,
    repos,
    running,
    buildState,
    resolveGroup,
    conflictsFor,
    subscribe,
    attentionSeen,
    rescan,
    refreshRunning,
    broadcastTopology,
    scheduleBroadcast,
    forgetFeature,
    onEventsSubscribed,
    onCommit,
  } = deps;

  /**
   * Where a worktree's server was last seen listening, for servers.stop().
   *
   * Not the same question as "which ports should it be on": a server started outside
   * Studio, or by a start command that ignored the slot env, binds somewhere else
   * entirely, and stop()'s sweep would never look there. Discovery already knows —
   * this is the one line that tells stop() what it knows.
   */
  const seenPorts = (worktreePath: string): number[] => running().get(realpath(worktreePath))?.ports ?? [];

  /** The post-stop world, for stopAll's guarded slot release: refresh, then read. */
  const liveServers = async () => {
    await refreshRunning();
    return running();
  };

  /** Bound here rather than handed over as `manager.get`, which would lose its receiver. */
  const getSession = (id: string) => manager.get(id);

  /*
   * Forward a manager answer, refusing to pass on a failure with no reason.
   *
   * Six SessionManager methods answer a bare `{ok:false}` where their siblings answer
   * `{ok:false, error:'…'}`, and these routes forwarded both verbatim with a 200 — so
   * pressing Close Tab on a window the multiplexer would not kill produced a response
   * with nothing in it to report, log or retry, indistinguishable from a client bug.
   *
   * Most of those bare answers are "no such session", and requireSession() below now
   * catches that case before the manager is called at all. What is left is the genuinely
   * silent half — the multiplexer refusing — which the route cannot diagnose but CAN
   * name, because it knows what it just asked for. `whenSilent` is that sentence.
   *
   * Still a 200: the operation was well-formed and really was attempted. Fixing the
   * status too belongs with fixing sessions.ts, which is where the reason should have
   * come from in the first place.
   */
  const forward = (res: Response, out: unknown, whenSilent: string) => {
    const r = out as { ok?: unknown; error?: unknown } | null;
    if (r && typeof r === 'object' && r.ok === false && !r.error) {
      return res.json({ ...r, error: whenSilent });
    }
    return res.json(out);
  };

  const app = express();

  // Everything below sits behind the Host/Origin allowlist — see security.ts for
  // what each gate stops. It runs before the body parsers so a rejected request is
  // never given the chance to make us buffer 8 MB of its JSON.
  app.use(guard.browser);

  app.use(express.json({ limit: '8mb' }));
  app.use(express.text({ type: 'text/*', limit: '8mb' }));

  // The browser tab cannot be handed a header before it exists, so the boot token is
  // injected into the one document we hand it. That is safe precisely because of the
  // gate above: a cross-origin page cannot read this response body, and a rebinding
  // page is refused before there is a body to read. See webui.ts for which UI this is;
  // its SPA fallback is mounted after every route below.
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

  // attentionSeen(): SwiftBar and Alfred poll this route instead of subscribing to
  // /api/events, so a poll is what tells the watcher someone is still looking.
  api.get('/state', async (_req, res) => {
    attentionSeen();
    res.json(await buildState());
  });

  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    // subscribe() writes the full snapshot (one `topology` + one `session-state`)
    // before this client joins the fan-out, so it can never miss the snapshot or
    // see an event that predates it.
    const unsubscribe = subscribe(res);
    onEventsSubscribed();
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

  // ---- settings / connections / intake sources ----
  routesSettings.register(api, { cfg, saveConfig, rescan, broadcastTopology });
  routesSources.register(api, { cfg, repos });

  /*
   * Check a merge request out and point an agent at it.
   *
   * The whole reason a REVIEW queue belongs in a tool that runs agents: this turns "four
   * merge requests are waiting" into "four agents have read them". It is the only route
   * that creates a worktree for somebody else's branch.
   *
   * The branch is the MR's SOURCE branch and it lives on the remote, so the worktree is
   * cut from `origin/<branch>` — `worktree.create` fetches first, then adds a local branch
   * at the remote tip. Naming the worktree after the MR rather than the branch keeps a
   * review from being auto-grouped into a FEATURE with your own work: `feature/mfa-totp`
   * would collide by name with the worktree you already have.
   */
  api.post('/reviews/checkout', async (req, res) => {
    const { repo: repoName, branch, number, title, url } = req.body || {};
    if (!repoName || !branch || !number) {
      return res.status(400).json({ error: 'repo, branch and number are required' });
    }
    const found = requireRepo(res, repos(), repoName);
    if (!found.ok) return;
    const repoObj = found.value;

    const wtname = `review-${number}`;
    const made = await worktree.create(repoObj.path, String(branch), wtname, {
      base: `origin/${branch}`,
      layout: layoutMod.resolve(cfg),
      ...worktreeCopyOpts(cfg, repoObj.name),
    });
    // An existing review worktree is not a failure — it is the one you made last time.
    if (!made.ok && !/already exists/i.test(made.error || '')) return res.status(400).json(made);
    const worktreePath = made.path!;

    const seed = {
      source: 'review',
      id: String(number),
      title: `Review !${number}: ${String(title || branch)}`,
      body:
        `You are reviewing merge request !${number}${title ? ` — "${title}"` : ''} in ${repoObj.name}` +
        `${url ? ` (${url})` : ''}. This worktree is checked out at its source branch, \`${branch}\`. ` +
        `Read the diff against the target branch, then report what you find: correctness ` +
        `problems first, then anything that would be hard to maintain. Do not change the code ` +
        `unless I ask you to — this is a review.`,
      url: url ? String(url) : null,
    };

    const session = await manager.adopt({
      worktreePath,
      repoName: repoObj.name,
      repoPath: repoObj.path,
      branch: String(branch),
      wtname,
      seed,
    });
    await rescan();
    res.json({ ok: true, session, worktree: { name: wtname, path: worktreePath }, reused: !made.ok });
  });

  // ---- sessions ----
  api.post('/sessions', async (req, res) => {
    try {
      const { source, sourceId, text, name, repo, additionalRepos } = req.body || {};
      const found = requireRepo(res, repos(), repo);
      if (!found.ok) return;
      const repoObj = found.value;
      const seed = await sources.seed(cfg, source || 'freetext', {
        repoPath: repoObj.path,
        id: sourceId,
        text,
        name,
      });
      const extra = (Array.isArray(additionalRepos) ? additionalRepos : [])
        .map((rn: unknown) => repos().find((r) => r.name === rn))
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

  /*
   * The session-scoped verbs below all start the same way, and they did not used to.
   *
   * Each one handed :id straight to the manager and forwarded whatever came back with a
   * 200 — including the bare `{ok:false}` five of those methods answer for a session that
   * is not there. docs/api.md's own table says an unknown session is a 404, and every
   * route that guarded got that right; these are the ones that did not. requireSession()
   * is that guard, once.
   */
  api.post('/sessions/:id/rename', async (req, res) => {
    const s = requireSession(res, getSession, req.params.id);
    if (!s.ok) return;
    forward(
      res,
      await manager.rename(req.params.id, req.body?.title || ''),
      'that session could not be renamed',
    );
  });
  // Kill the mux session and relaunch it, keeping the conversation — see restartTerminal.
  api.post('/sessions/:id/restart-terminal', async (req, res) => {
    const s = requireSession(res, getSession, req.params.id);
    if (!s.ok) return;
    forward(res, await manager.restartTerminal(req.params.id), 'the terminal could not be restarted');
  });
  api.post('/sessions/:id/deactivate', async (req, res) => {
    const s = requireSession(res, getSession, req.params.id);
    if (!s.ok) return;
    forward(res, await manager.deactivate(req.params.id), 'that session could not be deactivated');
  });
  api.post('/sessions/:id/activate', async (req, res) => {
    const s = requireSession(res, getSession, req.params.id);
    if (!s.ok) return;
    forward(res, await manager.activate(req.params.id), 'that session could not be activated');
  });

  /** Feature worktrees this session has no record of — see features.ts for why. */
  const attachableFor = (s: Session | undefined) =>
    attachableWorktrees(
      repos(),
      s?.feature,
      new Set((s?.repos || []).map((r: SessionRepo) => r.repoPath)),
      (i) => identity.of(i),
    );

  // Add a repo to a session's feature (creates a same-named worktree + grants access).
  // Used by the UI button and the `wt-studio add-repo` CLI (David or claude).
  api.post('/sessions/:id/add-repo', async (req, res) => {
    const found = requireRepo(res, repos(), req.body?.repo);
    if (!found.ok) return;
    const repoObj = found.value;
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
        saveConfig();
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
    const s = requireSession(res, getSession, req.params.id);
    if (!s.ok) return;
    forward(res, await manager.addTab(req.params.id, req.body || {}), 'the multiplexer would not open a tab');
  });

  // `tab` is the multiplexer window id; `index` is the legacy positional form, kept so
  // an older client keeps working. The manager resolves either.
  api.post('/sessions/:id/select-tab', async (req, res) => {
    const s = requireSession(res, getSession, req.params.id);
    if (!s.ok) return;
    const b = req.body || {};
    // selectTab answers a bare `{ ok }` straight off the multiplexer, so this is the one
    // route where the reason is genuinely missing rather than merely a missing session:
    // tmux refusing to select a window it no longer has looked exactly like success.
    forward(
      res,
      await manager.selectTab(req.params.id, b.tab ?? b.index ?? 0),
      'the multiplexer would not select that tab',
    );
  });

  api.post('/sessions/:id/rename-tab', async (req, res) => {
    const s = requireSession(res, getSession, req.params.id);
    if (!s.ok) return;
    const b = req.body || {};
    forward(
      res,
      await manager.renameTab(req.params.id, b.tab ?? b.index ?? 0, b.title),
      'the multiplexer would not rename that tab',
    );
  });

  api.post('/sessions/:id/close-tab', async (req, res) => {
    const s = requireSession(res, getSession, req.params.id);
    if (!s.ok) return;
    const b = req.body || {};
    forward(
      res,
      await manager.closeTab(req.params.id, b.tab ?? b.index ?? 0),
      'the multiplexer would not close that tab',
    );
  });

  // Start / stop ALL dev servers of a session's shared workspace (every repo it owns).
  api.post('/sessions/:id/servers/start', async (req, res) => {
    const found = requireSession(res, getSession, req.params.id);
    if (!found.ok) return;
    const s = found.value;
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
      ...servers.decorate({ repo: r.repo, path: r.worktreePath }, running()),
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
    const found = requireSession(res, getSession, req.params.id);
    if (!found.ok) return;
    const owned = (found.value.repos || []).filter(promoted);
    /*
     * stopAll is the mirror of startAll, and this is the sequence it exists for: stop
     * each target, refresh, then release only the slots nothing still holds. Refreshing
     * BEFORE releasing is the load-bearing half — the guard reads what is still
     * listening, and a session's repos can be a strict subset of its feature's members,
     * so "I stopped mine" is not "the feature is down".
     */
    await servers.stopAll(
      owned.map((r) => ({ repo: r.repo, worktreePath: r.worktreePath, ports: seenPorts(r.worktreePath) })),
      liveServers,
    );
    broadcastTopology();
    res.json({ ok: true });
  });

  api.delete('/sessions/:id', async (req, res) => {
    // Capture the session BEFORE close (close deletes it). Mirror /api/group/delete's
    // orphan cleanup: stop each owned worktree's dev servers + release its slot, else a
    // running server is orphaned and its concurrency slot leaks.
    const s = manager.get(req.params.id);
    const owned: PromotedRepo[] = s ? (s.repos || []).filter(promoted) : [];
    for (const r of owned) await servers.stop(r.repo, r.worktreePath, seenPorts(r.worktreePath));
    const out = await manager.close(req.params.id, { kill: req.query.kill !== 'false' });
    if (owned.length) {
      await refreshRunning(); // the guard below reads the post-stop world
      for (const r of owned) servers.releaseSlotIfIdle(servers.featureFor(r.worktreePath), running());
      broadcastTopology();
    }
    // No requireSession() here, unlike its neighbours: docs/api.md states outright that
    // this route answers `{ ok: false }` for an unknown session, so a 404 would break a
    // stated contract. What it must not do is answer that with nothing in it to read.
    forward(res, out, 'no such session');
  });

  // ---- review: the branch's commits, one commit's diff, and committing ----
  routesCommits.register(api, { manager, repos, resolveGroup, onCommit });

  // ---- worktrees (manual) ----
  api.post('/worktrees', async (req, res) => {
    const { repo, branch, name } = req.body || {};
    if (!branch && !name) return res.status(400).json({ error: 'branch or name is required' });
    const found = requireRepo(res, repos(), repo);
    if (!found.ok) return;
    const repoObj = found.value;
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
    const { repo, branch, deleteBranch, force } = req.body || {};
    const found = requireRepo(res, repos(), repo);
    if (!found.ok) return;
    // Its three siblings all guard this; this one passed the value straight into a git
    // argv, so an omitted field became the literal string "undefined" in an error that
    // was then reported with a 200. requireBody() takes only a real string, for exactly
    // that reason — an object here would coerce to "[object Object]" and reach the argv.
    const asked = requireBody(res, req.body, ['worktreePath']);
    if (!asked.ok) return;
    const out = await worktree.remove(found.value.path, asked.value.worktreePath, {
      branch,
      deleteBranch,
      force: !!force,
    });
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
     *
     * The check itself is requireBody() — this route and its two neighbours below were
     * three identical copies of it, which is three places to forget a field.
     */
    const asked = requireBody(res, req.body, ['repo', 'worktreePath']);
    if (!asked.ok) return;
    const { repo, worktreePath } = asked.value;
    const member = {
      repo,
      path: worktreePath,
      ...servers.decorate({ repo, path: worktreePath }, running()),
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
    const asked = requireBody(res, req.body, ['repo', 'worktreePath']);
    if (!asked.ok) return;
    const { repo, worktreePath } = asked.value;
    const out = await servers.stop(repo, worktreePath, seenPorts(worktreePath));
    await refreshRunning();
    // This route already had the right rule; it is now the shared one (releaseSlotIfIdle).
    servers.releaseSlotIfIdle(servers.featureFor(worktreePath), running());
    broadcastTopology();
    res.json(out);
  });
  api.post('/servers/restart', async (req, res) => {
    const asked = requireBody(res, req.body, ['repo', 'worktreePath']);
    if (!asked.ok) return;
    const { repo, worktreePath } = asked.value;
    const feature = servers.featureFor(worktreePath);
    const alloc = servers.allocSlotFor(feature); // reuse the feature's slot across the restart
    if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    const out = await servers.restart(
      repo,
      worktreePath,
      servers.launchOpts(repo, feature),
      seenPorts(worktreePath),
    );
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

  /*
   * Hand a finished run to the agent working in that worktree.
   *
   * The session is looked up FROM THE RUN's worktree rather than taken from the request:
   * a run belongs to a worktree, exactly one session owns a worktree, and letting the
   * client name the target would let a stale tab send a failure to whichever agent it
   * last had selected.
   */
  api.post('/runs/:id/to-agent', async (req, res) => {
    const out = await handoff(
      {
        getRun: (id) => runner.get(id),
        sessionFor: (p) => manager.sessionForWorktree(p),
        send: (mux, text, session) => manager.sendWhenReady(mux, text, session as never),
      },
      req.params.id,
    );
    // 200 for "the agent is not ready", 400 for "there is nothing to send": the first is
    // a state the client should explain, not an error it should report as a failure.
    if (!out.ok && !out.skipped) return res.status(400).json(out);
    res.json(out);
  });

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
    saveConfig,
    servers,
    manager,
    repos,
    resolveGroup,
    conflictsFor,
    refreshRunning,
    /*
     * Deleting a feature has to reach the caches keyed by its name, not just the config.
     *
     * reviewFeed is deliberately absent: it is keyed by REPO, and a repo does not go away
     * when a feature does. Its prune runs off the sweep, and its forget() stays the
     * manual "ask this repo again now" hook.
     */
    forgetFeature,
    running,
    scheduleBroadcast: broadcastTopology,
    rescan,
  });

  // GET /sessions/:id/ci (still an on-demand answer for SwiftBar/Alfred and any
  // external caller) + POST /group/pr. Created by server.ts, next to the feed it feeds.
  forge.register(api);

  // Start a session in an existing worktree (Fleet: "Start session here"), and bring a
  // closed one back from the conversation Claude Code still has on disk.
  routesOrphans.register(api, {
    cfg,
    manager,
    repos,
    layout: identity.layout,
    rescan,
    broadcastTopology,
  });

  api.post('/worktrees/adopt', async (req, res) => {
    const { repo, worktreePath, branch, wtname } = req.body || {};
    if (!worktreePath) return res.status(400).json({ error: 'worktreePath is required' });
    const found = requireRepo(res, repos(), repo);
    if (!found.ok) return;
    let s = await manager.adopt({ worktreePath, repoName: repo, repoPath: found.value.path, branch, wtname });
    if (!s) s = manager.sessionForWorktree(worktreePath); // an adopt was already in flight
    broadcastTopology();
    res.json(s || { error: 'session is already being opened' });
  });

  routesOpen.register(api, { cfg });
  // The index is the one collaborator a route module OWNS rather than is handed, and it
  // holds an open sqlite database. Parked on app.locals — express's app-scoped bag — so a
  // caller that built a throwaway app can close it, without buildApp having to answer
  // with something other than the app.
  app.locals.transcriptIndex = transcriptRoutes.register(api, { manager, cfg }).index;
  routesReview.register(api, { manager, repos, broadcast: scheduleBroadcast });

  // The Claude Code hook receiver. NOT under /api, and so not behind guard.authed — see
  // server/routes-hook.ts for the grandfathering that forces the exemption.
  routesHook.register(app, { manager, denyToken: guard.denyToken });

  // Client-side routes (/review, /search, /usage) reach the daemon on a deep link or a
  // reload, and the daemon knows nothing about them. Last, so it shadows no route above.
  webui.mountFallback(app, { ui, token: cfg._token });

  // Truly last: the net every route above falls into. express@5 awaits handlers, so a
  // handler that throws — or a body parser that refuses a body — lands here and gets an
  // answer, instead of escaping as the unhandled rejection crash.install() treats as
  // fatal. This is why no handler above needs a wrapper around it.
  app.use(crash.routeErrors());

  return app;
}

export { buildApp };
