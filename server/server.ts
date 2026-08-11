/*
 * The daemon: everything that needs a real process.
 *
 * Config off disk, a state directory, the multiplexer, the repo scan cache, the pulled
 * feeds, the SSE bus, filesystem watchers, an http server with the WebSocket upgrade
 * handler in front of it, crash policy, and session restore. It builds the collaborators
 * and hands them to buildApp() (server/app.ts), which owns every route and every piece
 * of middleware.
 *
 * The split is not cosmetic. This file ends in `main().catch(…)`, so importing it boots
 * a daemon — which is why the routes could not be reached from a test while they lived
 * here. server/app.ts has no side effects at import and no process concerns at all, so
 * test/app-surface.test.ts assembles the REAL app in-process and asks the router what it
 * mounted. Anything added below is wiring; anything added to app.ts is surface.
 */
import http from 'http';
import { WebSocketServer } from 'ws';
import * as gitMod from './git.ts';
import * as watchMod from './watch.ts';
import { SessionManager } from './sessions.ts';
import { Servers } from './servers.ts';
import { createIdentity } from './identity.ts';
import { createState } from './state.ts';
import { createBroadcast } from './broadcast.ts';
import { createForge } from './forge.ts';
import { createCiFeed } from './ci.ts';
import { createTaskStatusFeed } from './task-status.ts';
import { createOverlapFeed } from './overlap.ts';
import { createReviewFeed } from './reviews.ts';
import { createGuard } from './security.ts';
import { createTerminalHandler } from './term.ts';
import { createRescan } from './rescan.ts';
import { createAdopter, describeAdoption } from './adopt.ts';
import { Runner } from './runner.ts';
import * as webui from './webui.ts';
import * as crash from './crash.ts';
import { fire, expandTilde } from './util.ts';
import * as configMod from './config.ts';
import tmux, { reapLaunchScripts } from './multiplexer/tmux.ts';
import { buildApp } from './app.ts';
import type { ScannedRepo } from './git.ts';
import fs from 'fs';

/** A thrown value's message. `catch` binds `unknown`, and not everything thrown is an Error. */
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
  // Heals worktrees Studio did not create — see server/adopt.ts. Built once so it can
  // remember which worktrees it has already looked at across scans.
  const adoptScanned = createAdopter({ cfg });
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
    // After the scan, before the topology goes out: a worktree made outside Studio is
    // already in `repos`, but it never got the run configs or the gitignored local
    // config the copy step only ran inside create(). Fire and forget — the topology
    // must not wait on a copy, and the pass reports only what it actually healed.
    adoptScanned(repos)
      .then((healed) => {
        for (const h of healed) console.log(`[wt-studio] ${describeAdoption(h)}`);
      })
      .catch(() => {
        /* contained per-worktree already; this is the belt for the pass itself */
      });
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
    // The same trigger, for the same reason: a rescan means refs moved, and refs moving
    // is the only thing that can change an overlap or a drift count.
    fire(refreshOverlap());
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
  const { buildState, topology, sessionState, ciSubjects, prunePaths, resolveGroup, conflictsFor } =
    createState({
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

  /*
   * Merge requests awaiting your review, across every scanned repo.
   *
   * Asked from each repo's MAIN checkout: a worktree is on a feature branch and the
   * question is about the repo, not the branch — and the main checkout is the one path
   * that is always there.
   */
  const reviewFeed = createReviewFeed({ list: (p) => forge.reviewsFor(p) });
  const refreshReviews = async () => {
    if (await reviewFeed.refresh(repos.map((r) => ({ name: r.name, path: r.path })))) {
      bus.schedule({ ci: true });
    }
  };

  /*
   * Which features are changing the same files, and how far each has drifted.
   *
   * Rides the `ci` frame for the same reason taskStatus does: it is pulled rather than
   * pushed, it costs a handful of git reads per worktree, and it changes on the order of
   * commits — not on the order of file saves, which is what the topology tracks. The feed
   * caches on (head sha, base sha), so a sweep where nothing has been committed costs one
   * `rev-parse` per worktree and no diffs at all.
   */
  const overlapFeed = createOverlapFeed();
  const refreshOverlap = async () => {
    const t = topology();
    const bases = new Map(t.repos.map((r) => [r.name, r.defaultBranch || 'master']));
    const feats = [...t.features, ...t.groups].map((f) => ({
      name: f.name,
      members: (f.members || [])
        .filter((m): m is Extract<typeof m, { path: string }> => !!m && !('missing' in m && m.missing))
        // A main checkout is not somebody's branch work, and it is the base everything
        // else is measured against — including it would compare master with itself.
        .filter((m) => !m.isMain && !!m.path)
        .map((m) => ({ repo: m.repo, path: m.path, branch: m.branch })),
    }));
    const baseFor = (repo: string) => {
      const b = bases.get(repo) || 'master';
      // Measured against the REMOTE tip: the local base branch in a worktree checkout is
      // whatever it was last pulled to, so drift would read as zero on a stale main.
      return `origin/${b}`;
    };
    if (await overlapFeed.refresh(feats, baseFor)) bus.schedule({ ci: true });
  };

  const bus = createBroadcast({
    topology,
    sessionState,
    ci: () => ({
      ...ciFeed.snapshot(),
      taskStatus: taskFeed.snapshot(),
      overlap: overlapFeed.snapshot(),
      reviews: reviewFeed.snapshot(),
    }),
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
  // A UI that isn't on disk is a boot failure, not a 404 the user has to reverse-
  // engineer: say what is missing and how to get it, and stop. Resolved here rather
  // than in buildApp because `process.exit` is a process decision.
  let ui: webui.ResolvedUi;
  try {
    ui = webui.resolve();
  } catch (e) {
    console.error(`[wt-studio] ${msg(e)}`);
    process.exit(1);
  }
  console.log(`[wt-studio] serving the ${ui.label}`);

  const guard = createGuard({ cfg, token: cfg._token });

  const app = buildApp({
    cfg,
    saveConfig: () => configMod.save(cfg),
    guard,
    ui,
    manager,
    servers,
    runner,
    identity,
    forge,
    repos: () => repos,
    running: () => runningCache,
    buildState,
    resolveGroup,
    conflictsFor,
    subscribe: (res) => bus.subscribe(res),
    attentionSeen: () => attention.seen(),
    rescan,
    refreshRunning,
    broadcastTopology,
    scheduleBroadcast,
    forgetFeature: (name: string) => {
      taskFeed.forget(name);
      overlapFeed.forget(name);
    },
    onEventsSubscribed: () => {
      // Someone started looking. While nobody was, the CI feed deliberately did
      // nothing at all, so its snapshot may be stale or empty — this is what makes an
      // opened dashboard fill in within a second rather than at the next safety net.
      ciFeed.poke();
      // Same reason, and equally cheap: with no ticket configured, or nothing stale, this
      // is a filter over a small object and no request at all.
      fire(refreshTaskStatus());
      fire(refreshOverlap());
      fire(refreshReviews());
    },
    onCommit: () => {
      broadcastTopology();
      ciFeed.poke({ force: true });
      // The same trigger, for the same reason: a rescan means refs moved, and refs moving
      // is the only thing that can change an overlap or a drift count.
      fire(refreshOverlap());
    },
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
    /*
     * The pulled feeds get a heartbeat, which three of the four never had.
     *
     * ci.ts carried its own tick; reviews, ticket status and overlap were driven only by
     * an SSE subscribe, a rescan and a commit. Leave one tab open and none of those fire
     * again — so the review queue's five-minute TTL and ticket status's ten were
     * decorative, and the data on screen could be hours stale while looking live. The
     * scheduler here already knows whether anyone is watching, which is the thing that
     * makes polling three subprocess-spawning feeds affordable.
     */
    feeds: { reviews: refreshReviews, taskStatus: refreshTaskStatus, overlap: refreshOverlap },
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
    /*
     * The printed URL carries the token, because the bare one no longer opens anything.
     *
     * The document is gated now — serving the shell to anyone who asked was how the
     * token reached any local process on the machine. The cost is that every habitual
     * way in (this line, a bookmark, the menubar) had to learn to hand it over once;
     * the page swaps it for a cookie and strips it from the address bar immediately.
     *
     * Yes, this puts the token in the daemon's log. That log is written to the state
     * directory alongside the token file itself, and anything that can read one can
     * read the other — so it gives away nothing new, and the alternative is printing a
     * link that lands the user on a challenge page with no explanation.
     */
    const base = `http://${cfg.web.host}:${cfg.web.port}`;
    console.log(
      `[wt-studio] ${base}/?token=${cfg._token}  (${repos.length} repos, mux=${mux ? mux.name : 'none'})`,
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
