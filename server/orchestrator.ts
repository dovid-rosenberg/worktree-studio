// Feature/group orchestration: the "run the whole stack" verbs the Fleet rail,
// SwiftBar and Alfred drive. A feature is a set of same-named worktrees across
// repos (see features.ts); these routes act on all of its members at once —
// start / stop / restart the dev servers, open them in an editor, close or delete
// the feature, and start the one session that drives it.
//
// Two things every verb here has to get right:
//   - concurrency slots: a slot is keyed on the member's OWN feature identity
//     (servers.featureFor → server/identity.ts, the same resolver features.ts
//     groups with), allocated before any launch and released once the whole stack
//     is down, so a leaked slot never blocks the next feature.
//   - conflicts: another worktree of the same repo already running, which has to be
//     stopped before this one can bind the same ports (unless the repo is slotted).
import type { Router } from 'express';
import * as worktree from './worktree.ts';
import { openEditor, resolveEditor, shq } from './util.ts';
import * as startReport from './start-report.ts';
import type { StartOutcome } from './start-report.ts';

// The collaborators below are typed by the surface these routes touch, not by the
// concrete objects server.ts hands over — the same rule server/routes-review.ts
// follows. It is what lets test/api-routing.test.js drive every verb with a recording
// fake, and it is also the only option while server/state.ts is still untyped.

/**
 * One worktree row: a member of the resolved feature, or an entry in the flat list
 * conflictsFor() filters. `types.ts`'s `Worktree` satisfies it.
 */
interface Member {
  repo: string;
  path: string;
  branch?: string | null;
  wtname?: string;
  running?: boolean;
  /**
   * Where this member was last SEEN listening — not where its slot says it should be.
   * Handed to servers.stop() so a server that drifted onto another feature's ports is
   * still reachable by the row that owns it.
   */
  ports?: number[];
  canStart?: boolean;
  /** Why `canStart` is false — see servers.decorate(). Both feed skipReason(). */
  depsMissing?: boolean;
  noStartCmd?: boolean;
  session?: { id: string } | null;
}

/** A feature/group as resolveGroup() answers it — every member is really on disk. */
interface ResolvedGroup {
  members: Member[];
}

/**
 * Whatever servers.launchOpts() answers. Opaque on purpose: this module only pipes it
 * straight back into start()/restart() and never reads a field of it.
 */
type LaunchOpts = unknown;

interface Servers {
  featureFor(worktreePath: string): string;
  allocSlotFor(feature: string): { slot?: number; error?: string };
  /**
   * Release only when nothing of the feature is still listening. Replaces the bare
   * releaseSlot() these routes used to call: stopping every member this route knows about
   * is not the same as the feature being down, because a feature can own a worktree the
   * caller never enumerated. See servers.ts.
   */
  releaseSlotIfIdle(feature: string, running: Map<string, { pid: number; ports: number[] }>): boolean;
  /** Unconditional. Only /group/delete may use it — the worktrees are gone by then. */
  releaseSlot(feature: string): void;
  launchOpts(repo: string, feature: string): LaunchOpts;
  // `listening` is the strong verdict: true = every expected port bound, false = the
  // poll window expired with one still down, undefined = nothing to check. See
  // servers.ts's StartResult for why the third case is not folded into the others.
  /**
   * Allocate every slot, then launch every target. One implementation of a sequence three
   * routes used to spell out independently — see servers.ts.
   */
  startAll(targets: Array<{ repo: string; worktreePath: string }>): Promise<
    | { ok: false; slotError: string }
    | {
        ok: true;
        results: StartOutcome[];
      }
  >;
  /*
   * The real outcome, not `unknown` — the same narrowing trap `restart` had.
   *
   * Declaring less than Servers.stop() actually returns type-ERASES the answer on the way
   * in, so this route could not have reported a server that refused to die even if it had
   * tried. That is how /group/restart came to report "3/3 restarted" for three servers
   * that never bound a port.
   */
  stop(
    repo: string,
    worktreePath: string,
    alsoPorts?: number[],
  ): Promise<{ ok: true; killed: boolean; stillListening: number[] }>;
  /*
   * The FULL outcome, not `{ok, error}`.
   *
   * A narrowed type here is not a simplification, it is a silent bug: `Servers.restart`
   * really answers a StartResult, and declaring less erased `listening`/`boundElsewhere`
   * on the way in, so /group/restart could not have reported a server that spawned and
   * never bound even if it had tried.
   */
  restart(
    repo: string,
    worktreePath: string,
    opts: LaunchOpts,
    alsoPorts?: number[],
  ): Promise<Omit<StartOutcome, 'repo'>>;
}

/** The session these routes hand back untouched; only its id is ever read. */
interface SessionRef {
  id: string;
}

interface Manager {
  deactivate(id: string): Promise<unknown>;
  close(id: string): Promise<unknown>;
  sessionForWorktree(worktreePath: string): SessionRef | null | undefined;
  adopt(args: {
    worktreePath: string;
    repoName: string;
    repoPath: string;
    branch?: string | null;
    wtname?: string;
  }): Promise<SessionRef | null>;
  attachRepo(
    id: string,
    args: { repo: string; repoPath: string; worktreePath: string; branch?: string | null; wtname?: string },
  ): Promise<unknown>;
}

/** One scan-cache row: the repo name a member names, and the checkout to run git in. */
interface RepoRef {
  name: string;
  path: string;
}

interface OrchestratorDeps {
  cfg: {
    editors?: Record<string, { open: string; openGroup?: string }>;
    defaultEditor: string;
    /** Per-feature decoration, cleaned up when the feature is deleted. */
    featureColors?: Record<string, string>;
    featureLinks?: Record<string, unknown>;
  };
  /** Persist cfg — called after the delete strips a feature's decoration. */
  saveConfig?: () => void;
  servers: Servers;
  manager: Manager;
  repos: () => RepoRef[];
  /**
   * `name` arrives straight off the wire, so every call site coerces it with
   * String() first — the resolver only ever compares it against a feature name.
   */
  resolveGroup: (name: string) => Promise<{ group: ResolvedGroup | null; flat: Member[] }>;
  conflictsFor: (member: Member, flat: Member[]) => Member[];
  refreshRunning: () => Promise<unknown>;
  /** Drop a deleted feature from the pulled feeds that are keyed by feature name. */
  forgetFeature?: (name: string) => void;
  /** The discovered running map, read AFTER refreshRunning() so slot release can be guarded. */
  running: () => Map<string, { pid: number; ports: number[] }>;
  scheduleBroadcast: () => void;
  rescan: () => Promise<unknown>;
}

/**
 * The POST bodies these routes read. Every field is `unknown`: a JSON body can carry
 * anything, so nothing here is a string or a boolean until it has been coerced.
 */
interface GroupBody {
  group?: unknown;
  stopConflicts?: unknown;
  editor?: unknown;
  deleteBranches?: unknown;
  /** `git worktree remove --force` — see WorktreeRemoveOptions.force. */
  force?: unknown;
}

// `app` here is the API router — server.ts mounts it at both /api and /api/v1.
function register(app: Router, deps: OrchestratorDeps): void {
  const {
    cfg,
    saveConfig,
    servers,
    manager,
    repos,
    resolveGroup,
    conflictsFor,
    refreshRunning,
    forgetFeature,
    running,
    scheduleBroadcast,
    rescan,
  } = deps;

  /**
   * Free the feature's slot for every member, but only if the feature is genuinely down.
   * Always called AFTER refreshRunning(), because the guard reads what is still listening.
   */
  const releaseIdleSlots = (members: Member[]): void => {
    const live = running();
    for (const m of members) servers.releaseSlotIfIdle(servers.featureFor(m.path), live);
  };

  app.post('/group/start', async (req, res) => {
    const { group, stopConflicts }: GroupBody = req.body || {};
    const { group: g, flat } = await resolveGroup(String(group ?? ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    // Both halves of the split come from server/start-report.ts, which is also what the
    // session route uses — that shared rule is the whole reason this cannot drift again.
    const toStart = startReport.toStart(g.members);
    const skipped = startReport.toSkip(g.members);
    const conflicts: Member[] = [];
    const seen = new Set<string>();
    for (const m of toStart)
      for (const c of conflictsFor(m, flat))
        if (!seen.has(c.path)) {
          seen.add(c.path);
          conflicts.push(c);
        }
    if (conflicts.length && !stopConflicts) {
      // `skipped` rides along so the confirm dialog can say what this start will NOT
      // bring up, before the user agrees to stop something else for it.
      return res.json({ ok: true, needsConfirm: true, conflicts, willStart: toStart, skipped });
    }
    if (stopConflicts) {
      /*
       * Stopping a conflict has to FREE ITS SLOT, or the stop is the whole of what happens.
       *
       * This stopped the conflicting features and released nothing. With maxSlots 2 and A
       * and B running, agreeing to stop conflicts so C can start took A down, waited, and
       * then found both slots still held — startAll answered "no free concurrency slot",
       * the route returned 409, and the user was left with A stopped, C never started and
       * an error that named neither. The slots were only reclaimed a sweep later, by
       * reconcileSlots, long after this request had failed.
       *
       * The settle stays where it was and now earns its keep twice: a server that has just
       * been SIGTERMed can hold its socket for a moment, and asking "is this feature still
       * listening?" too early answers yes and keeps the slot anyway.
       */
      for (const c of conflicts) await servers.stop(c.repo, c.path, c.ports);
      await new Promise((r) => setTimeout(r, 1200));
      await refreshRunning();
      releaseIdleSlots(conflicts);
    }
    // Key each slot on the member's own feature identity — the one canonical key.
    // Members of a real feature resolve to the same identity → one slot; under the
    // default `basename` strategy a degenerate mixed-name manual group gets a
    // per-worktree slot each (the `manifest` strategy is what fixes that).
    // Slots first, then launches — servers.startAll owns that sequence for all three
    // routes that need it, so they cannot drift apart again.
    const out = await servers.startAll(toStart.map((m) => ({ repo: m.repo, worktreePath: m.path })));
    if (!out.ok) return res.status(409).json({ ok: false, error: out.slotError });

    await refreshRunning();
    scheduleBroadcast();
    res.json(startReport.report(out.results, skipped));
  });

  app.post('/group/stop', async (req, res) => {
    const { group }: GroupBody = req.body || {};
    const { group: g } = await resolveGroup(String(group ?? ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const running_ = g.members.filter((m) => m.running);
    const stops = await Promise.all(
      running_.map(async (m) => ({ repo: m.repo, ...(await servers.stop(m.repo, m.path, m.ports)) })),
    );
    // Refresh first, then release: the guard reads what is still listening, and this
    // released the slot BEFORE looking — so a member that refused to die still took its
    // ports while the slot went back in the pool.
    await refreshRunning();
    releaseIdleSlots(g.members);
    scheduleBroadcast();
    /*
     * `ok` means the stack is actually down.
     *
     * This answered a hardcoded `{ok: true}` and discarded every per-member result, so a
     * dev server that installs a SIGTERM handler and keeps listening was reported as
     * stopped while its port was still bound. stop() now re-checks and escalates; this
     * reports what it found.
     */
    const stubborn = stops.filter((s) => s.stillListening.length);
    res.json({
      ok: stubborn.length === 0,
      stopped: stops.length - stubborn.length,
      total: stops.length,
      ...(stubborn.length
        ? {
            failures: stubborn.map((s) => ({
              repo: s.repo,
              error: `still listening on port ${s.stillListening.join(', ')} after SIGTERM and SIGKILL`,
            })),
          }
        : {}),
    });
  });

  app.post('/group/restart', async (req, res) => {
    const { group }: GroupBody = req.body || {};
    const { group: g } = await resolveGroup(String(group ?? ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const toRestart = g.members.filter((m) => m.running || m.canStart);
    // Same omission /group/start had: a member that is neither running nor startable is
    // dropped here too, and a restart that silently brings back less than was asked for
    // is the same lie in a different verb.
    const skipped = startReport.toSkip(g.members);
    for (const m of toRestart) {
      const alloc = servers.allocSlotFor(servers.featureFor(m.path)); // reuse the feature's slot across the restart
      if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    }
    /*
     * The full StartResult per member, not just `ok`.
     *
     * This counted "the process spawned" as "restarted" because the narrowed `Servers`
     * interface below declared `restart()` as `{ok, error}` — it really answers a
     * StartResult, so `listening` and `boundElsewhere` were being type-erased on the way
     * in. A restart of a repo that ignores its slot's port env var therefore reported
     * `3/3, failures: []` while the ports the UI watches stayed dark, and the message
     * written to explain exactly that never reached this verb.
     */
    const results = await Promise.all(
      toRestart.map(async (m) => ({
        repo: m.repo,
        ...(await servers.restart(
          m.repo,
          m.path,
          servers.launchOpts(m.repo, servers.featureFor(m.path)),
          m.ports,
        )),
      })),
    );
    await refreshRunning();
    scheduleBroadcast();
    res.json(startReport.report(results, skipped));
  });

  app.post('/group/open', async (req, res) => {
    const { group, editor }: GroupBody = req.body || {};
    const { group: g } = await resolveGroup(String(group ?? ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    // String(): `editor` is whatever the body carried — it can be an array, an object,
    // a number. A property access coerces the key exactly this way already, so naming
    // the coercion cannot change which editor is picked.
    // Same resolution as POST /open, from the same helper — this was the second copy of
    // an expression that could not tell an unnamed editor from an unknown one.
    const pick = resolveEditor(cfg.editors, editor, cfg.defaultEditor);
    if (!pick.ok) return res.status(400).json({ ok: false, error: pick.error });
    const ed = pick.editor;
    const paths = g.members.map((m) => m.path);
    // split/join, never replace(): the shell-quoted path is the REPLACEMENT string, and
    // `$&`, `` $` ``, `$'` and `$$` in a replacement string are expanded by the engine
    // AFTER shq() has done its quoting — so a worktree path containing `$&` would open
    // some other path entirely, quoting notwithstanding. split/join is literal.
    const cmds = ed.openGroup
      ? [ed.openGroup.split('{paths}').join(paths.map(shq).join(' '))]
      : paths.map((p) => ed.open.split('{path}').join(shq(p)));
    const opened = await openEditor(cmds);
    if (!opened.ok) return res.status(500).json({ ok: false, error: `editor failed: ${opened.error}` });
    res.json({ ok: true });
  });

  // Close a feature: stop its servers + deactivate its sessions (keep worktrees).
  app.post('/group/close', async (req, res) => {
    const { group: g } = await resolveGroup(String(req.body?.group ?? ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    for (const m of g.members) {
      if (m.running) await servers.stop(m.repo, m.path, m.ports);
      if (m.session) await manager.deactivate(m.session.id);
    }
    // Close had no refresh at all, so it released against a stale map.
    await refreshRunning();
    releaseIdleSlots(g.members);
    scheduleBroadcast();
    res.json({ ok: true });
  });

  // Delete a feature: kill its sessions + remove its worktrees (optionally branches).
  app.post('/group/delete', async (req, res) => {
    const { group, deleteBranches, force }: GroupBody = req.body || {};
    const name = String(group ?? '');
    const { group: g } = await resolveGroup(name);
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const results: Array<{ repo: string; ok: boolean; error?: string; branchError?: string }> = [];
    for (const m of g.members) {
      const repoObj = repos().find((r) => r.name === m.repo);
      if (!repoObj) {
        results.push({ repo: m.repo, ok: false, error: 'unknown repo' });
        continue;
      }
      /*
       * STOP THE SERVER, REMOVE THE WORKTREE, and only then close the session.
       *
       * The session used to be closed BEFORE the removal, so a removal git refused —
       * an untracked file is enough, and Studio's own Install-dependencies button
       * creates one — had already destroyed the agent. The user was left with a
       * worktree that still existed, no session driving it, and an error telling them
       * to retry something that would fail identically forever.
       *
       * The server stop stays first: a live dev server holds the directory open, so
       * removing under it is the failure this ordering exists to avoid. Only the
       * session close moved.
       */
      if (m.running) await servers.stop(m.repo, m.path, m.ports);
      const rr = await worktree.remove(repoObj.path, m.path, {
        branch: m.branch,
        deleteBranch: !!deleteBranches,
        force: !!force,
      });
      // The agent goes with the worktree it was working in — and only if that worktree
      // actually went. A surviving worktree keeps its session.
      if (rr.ok && m.session) await manager.close(m.session.id);
      /*
       * The branch refusal rides along. `git branch -d` declines an unmerged branch, and
       * that outcome was discarded here — so "Also delete the branches" answered a clean
       * success and left every branch standing. The worktree really did go, so `ok` stays
       * true; what changes is that the part which did NOT happen is now named.
       */
      results.push({
        repo: m.repo,
        ok: rr.ok,
        error: rr.ok ? undefined : rr.error,
        ...(rr.ok && rr.branchError ? { branchError: rr.branchError } : {}),
      });
    }
    // Unconditional, and the ONE place that is right: the worktrees are gone, so the
    // feature no longer exists. Guarding here would leak the slot forever if some stray
    // process were still holding a port from a path that has been deleted.
    for (const m of g.members) servers.releaseSlot(servers.featureFor(m.path));
    /*
     * A deleted feature's decoration goes with it.
     *
     * `featureColors` and `featureLinks` are keyed by feature NAME, which is what makes
     * them outlive a session — deliberately. But nothing removed them when the feature
     * itself was deleted, and feature names are slugs of free text, so a later unrelated
     * feature that happens to share a name silently inherited the old ticket and colour.
     *
     * Worse in one direction: the promote-time copy explicitly refuses to overwrite an
     * existing ticket ("a ticket set by hand outranks the one intake guessed"), so the
     * stale entry actively BLOCKED the correct one from ever being written.
     */
    let stripped = false;
    for (const map of [cfg.featureColors, cfg.featureLinks]) {
      if (map && name in map) {
        delete map[name];
        stripped = true;
      }
    }
    if (stripped) saveConfig?.();
    /*
     * The in-memory feeds are keyed by feature name too, and nothing ever dropped them.
     *
     * reviews.ts and task-status.ts each export a `forget()` documented as the thing
     * called when a feature is deleted "so the map cannot grow forever". Neither had a
     * caller anywhere — the config decorations above were cleaned up and the caches were
     * not, so a deleted feature's ticket status outlived it for as long as the daemon
     * ran. Unbounded in the slow direction: every feature ever deleted stays resident.
     */
    forgetFeature?.(name);
    await rescan();
    res.json({ ok: results.every((r) => r.ok), results });
  });

  // One session per feature: return the existing one, or start a single session
  // that drives ALL the feature's worktrees (adopt the first, /add-dir the rest).
  app.post('/group/session', async (req, res) => {
    const { group: g } = await resolveGroup(String(req.body?.group ?? ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const members = g.members;
    if (!members.length) return res.status(400).json({ error: 'feature has no members' });
    for (const m of members) {
      const s = manager.sessionForWorktree(m.path);
      if (s) return res.json({ ok: true, session: s, existed: true });
    }
    const [primary, ...rest] = members;
    const pRepo = repos().find((r) => r.name === primary.repo);
    // A repo the scan cache has not seen. The `rest` loop below already skips one;
    // the primary went straight to `pRepo.path`, so the same miss was a TypeError —
    // a 500 leaking an internal message where the caller's own 400 belongs.
    if (!pRepo) return res.status(400).json({ error: 'unknown repo' });
    const session = await manager.adopt({
      worktreePath: primary.path,
      repoName: primary.repo,
      repoPath: pRepo.path,
      branch: primary.branch,
      wtname: primary.wtname,
    });
    if (session) {
      for (const m of rest) {
        const ro = repos().find((r) => r.name === m.repo);
        if (ro)
          await manager.attachRepo(session.id, {
            repo: m.repo,
            repoPath: ro.path,
            worktreePath: m.path,
            branch: m.branch,
            wtname: m.wtname,
          });
      }
    }
    scheduleBroadcast();
    res.json({ ok: true, session });
  });
}

export { register };
