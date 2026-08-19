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
import { defaultBase, updateFromBase } from './git.ts';
import { editorCommands, openEditor, requireFeature, requireRepo, resolveEditor } from './util.ts';
import * as startReport from './start-report.ts';
import type { StartOutcome } from './start-report.ts';
import type { SlotReport } from './types.ts';

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
  allocSlotFor(
    feature: string,
    opts?: { requested?: number; members?: Array<{ repo: string; worktreePath: string }> },
  ): Promise<{ slot?: number; error?: string }>;
  /** Every slot's availability for this feature's repos. Reads only. */
  slotReport(feature: string, members: Array<{ repo: string; worktreePath: string }>): Promise<SlotReport[]>;
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
  startAll(
    targets: Array<{ repo: string; worktreePath: string }>,
    opts?: { slot?: number },
  ): Promise<
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
   * `name` arrives straight off the wire; requireFeature() is what coerces it, so no
   * route below spells String() — the resolver only ever compares it against a name.
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
  /** The slot the user picked, or absent for the default policy. */
  slot?: unknown;
  /** /group/update: yes, stop the dev servers running in the worktrees being rebased. */
  stopServers?: unknown;
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

  /*
   * Every slot's availability for this feature.
   *
   * Deliberately a request rather than part of the topology frame: occupancy depends on
   * live port state, and computing it for every feature several times a second would put
   * an lsof per slot per feature on the broadcast path.
   */
  app.get('/group/:name/slots', async (req, res) => {
    const found = await requireFeature(res, resolveGroup, req.params.name);
    if (!found.ok) return;
    const g = found.value.group;
    if (!g.members.length) return res.json([]);
    const feature = servers.featureFor(g.members[0].path);
    const members = g.members.map((m) => ({ repo: m.repo, worktreePath: m.path }));
    res.json(await servers.slotReport(feature, members));
  });

  /*
   * Move a running feature to another slot.
   *
   * Necessarily a restart: ports come from env read at launch, and the FE config patch is
   * written to the worktree before spawn, so nothing slides across live.
   *
   * The target is verified BEFORE anything is stopped. Verifying after would allow a
   * half-moved feature — backend on the new slot, frontend dead — which is strictly worse
   * than not moving. The re-allocation after the stop is still the authority: another
   * feature can take the slot in the gap, and then this answers 409 with the feature down,
   * which the client reports plainly rather than dressing up as a success.
   */
  app.post('/group/slot', async (req, res) => {
    const { group, slot }: GroupBody = req.body || {};
    const want = Number(slot);
    if (!Number.isInteger(want) || want < 0) {
      return res.status(400).json({ ok: false, error: 'slot must be a non-negative integer' });
    }
    const found = await requireFeature(res, resolveGroup, group);
    if (!found.ok) return;
    const g = found.value.group;
    if (!g.members.length) return res.status(400).json({ ok: false, error: 'feature has no members' });

    const feature = servers.featureFor(g.members[0].path);
    const members = g.members.map((m) => ({ repo: m.repo, worktreePath: m.path }));

    const target = (await servers.slotReport(feature, members))[want];
    if (!target) return res.status(400).json({ ok: false, error: `slot ${want} does not exist` });
    if (target.state === 'current') return res.json({ ok: true, started: 0, total: 0 });
    if (target.state === 'held') {
      return res.status(409).json({ ok: false, error: `slot ${want} is held by ${target.heldBy}` });
    }
    if (target.state === 'blocked') {
      return res.status(409).json({
        ok: false,
        error: `slot ${want}: port ${target.blockedBy?.port} is in use by pid ${target.blockedBy?.pid}`,
      });
    }

    // Only members that were running come back up. A stopped one joins the new slot
    // whenever it is next started — starting it here would be doing something unasked.
    const wasRunning = g.members.filter((m) => m.running);
    for (const m of wasRunning) await servers.stop(m.repo, m.path, m.ports);
    await refreshRunning();

    servers.releaseSlot(feature);
    const alloc = await servers.allocSlotFor(feature, { requested: want, members });
    if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });

    const out = await servers.startAll(
      wasRunning.map((m) => ({ repo: m.repo, worktreePath: m.path })),
      { slot: want },
    );
    if (!out.ok) return res.status(409).json({ ok: false, error: out.slotError });
    await refreshRunning();
    scheduleBroadcast();
    res.json(startReport.report(out.results));
  });

  app.post('/group/start', async (req, res) => {
    const { group, stopConflicts, slot }: GroupBody = req.body || {};
    const found = await requireFeature(res, resolveGroup, group);
    if (!found.ok) return;
    const { group: g, flat } = found.value;
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
    const out = await servers.startAll(
      toStart.map((m) => ({ repo: m.repo, worktreePath: m.path })),
      slot === undefined ? {} : { slot: Number(slot) },
    );
    if (!out.ok) return res.status(409).json({ ok: false, error: out.slotError });

    await refreshRunning();
    scheduleBroadcast();
    res.json(startReport.report(out.results, skipped));
  });

  app.post('/group/stop', async (req, res) => {
    const { group }: GroupBody = req.body || {};
    const found = await requireFeature(res, resolveGroup, group);
    if (!found.ok) return;
    const g = found.value.group;
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
    const found = await requireFeature(res, resolveGroup, group);
    if (!found.ok) return;
    const g = found.value.group;
    const toRestart = g.members.filter((m) => m.running || m.canStart);
    // Same omission /group/start had: a member that is neither running nor startable is
    // dropped here too, and a restart that silently brings back less than was asked for
    // is the same lie in a different verb.
    const skipped = startReport.toSkip(g.members);
    // Reuse the feature's slot across the restart. Members are grouped by feature so the
    // availability judgement sees every port the feature needs, not one repo's worth.
    for (const m of toRestart) {
      const feature = servers.featureFor(m.path);
      const alloc = await servers.allocSlotFor(feature, {
        members: toRestart
          .filter((x) => servers.featureFor(x.path) === feature)
          .map((x) => ({ repo: x.repo, worktreePath: x.path })),
      });
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

  /*
   * UPDATE FROM BASE — the verb behind "behind 27".
   *
   * The drift chip has been able to say how far a feature has fallen behind its base
   * since overlap.ts shipped, and acting on it meant opening a terminal in each of the
   * feature's repos and typing the same rebase into every one. A branch 27 commits behind
   * is also the state the wrong-branch dev-server incidents come out of, so the number was
   * being shown at exactly the moment nothing could be done about it from here.
   *
   * PER MEMBER, like every other group verb: one repo of a feature can rebase cleanly
   * while another refuses because its tree is dirty, and reporting a single boolean for
   * the feature would hide whichever half needs the work. git.updateFromBase() owns the
   * refusals (see its comment for why rebase and not merge); this route owns the fact
   * that a feature is several repos, and the dev servers.
   *
   * THE DEV SERVERS ARE STOPPED FIRST, and only with the caller's agreement.
   * A rebase rewrites the working tree under whatever is watching it: a bundler picks up
   * files mid-replay, HMR pushes a module graph that matches no commit, and a server that
   * survives to the end is serving a tree it never read. Worse, the dev server is what
   * makes a worktree feel safe to leave running — so the failure looks like the app
   * breaking, not like the rebase. Refusing outright would make the verb useless (the
   * stack is usually up), and restarting automatically afterwards would be a second guess:
   * the base can bring a new lockfile down, so the honest next step is the ▶ button, which
   * re-checks whether the member can start at all. So: name what is running, ask, stop,
   * rebase, and report what was stopped.
   */
  app.post('/group/update', async (req, res) => {
    const { group, stopServers }: GroupBody = req.body || {};
    const found = await requireFeature(res, resolveGroup, group);
    if (!found.ok) return;
    const g = found.value.group;

    const live = g.members.filter((m) => m.running);
    if (live.length && !stopServers)
      // The same confirm shape /group/start uses for its conflicts, so the client has one
      // pattern to follow rather than two.
      return res.json({
        ok: true,
        needsConfirm: true,
        running: live.map((m) => ({ repo: m.repo, path: m.path, wtname: m.wtname })),
      });
    const stopped: string[] = [];
    if (live.length) {
      for (const m of live) {
        await servers.stop(m.repo, m.path, m.ports);
        stopped.push(m.repo);
      }
      // Refresh first, then release — the guard reads what is still listening, exactly as
      // /group/stop does. A slot left held here would block the ▶ the user is about to press.
      await refreshRunning();
      releaseIdleSlots(g.members);
    }

    const results: Array<{
      repo: string;
      base?: string;
      ok: boolean;
      updated: boolean;
      behind: number;
      error?: string;
      conflicts?: string[];
    }> = [];
    for (const m of g.members) {
      const repoObj = repos().find((r) => r.name === m.repo);
      if (!repoObj) {
        results.push({ repo: m.repo, ok: false, updated: false, behind: 0, error: 'unknown repo' });
        continue;
      }
      /*
       * The base is resolved from the repo, not taken from the request.
       *
       * defaultBase() keeps the `origin/` prefix — the same ref the drift feed measures
       * against (server.ts's baseFor) and the same one worktree.create() cuts from. A
       * caller-supplied base would let a POST body rebase four checkouts onto anything.
       *
       * No fetch: the number the user pressed was computed from the refs that are already
       * local, and a verb whose result does not match the number that invited it is worse
       * than one that is occasionally a fetch behind. The next sweep re-reads the drift.
       */
      const base = await defaultBase(repoObj.path);
      results.push({ repo: m.repo, base, ...(await updateFromBase(m.path, base)) });
    }

    // The heads moved, so every read keyed on them is stale: rescan re-describes the
    // worktrees and the drift feed recomputes off the new shas.
    await rescan();
    scheduleBroadcast();
    res.json({
      // "No failures", the same rule /group/start and /group/pr settled on. A feature
      // where three repos rebased and one refused is not an update that worked.
      ok: results.every((r) => r.ok),
      updated: results.filter((r) => r.updated).length,
      total: results.length,
      stopped,
      results,
    });
  });

  app.post('/group/open', async (req, res) => {
    const { group, editor }: GroupBody = req.body || {};
    const found = await requireFeature(res, resolveGroup, group);
    if (!found.ok) return;
    const g = found.value.group;
    // Same resolution as POST /open, from the same helper — this was the second copy of
    // an expression that could not tell an unnamed editor from an unknown one.
    const pick = resolveEditor(cfg.editors, editor, cfg.defaultEditor);
    if (!pick.ok) return res.status(400).json({ ok: false, error: pick.error });
    // ...and the templating is the same helper too, for the same reason: it was the
    // second copy, quoting hazard and all. See editorCommands().
    const opened = await openEditor(
      editorCommands(
        pick.editor,
        g.members.map((m) => m.path),
      ),
    );
    if (!opened.ok) return res.status(500).json({ ok: false, error: `editor failed: ${opened.error}` });
    res.json({ ok: true });
  });

  // Close a feature: stop its servers + deactivate its sessions (keep worktrees).
  app.post('/group/close', async (req, res) => {
    const found = await requireFeature(res, resolveGroup, req.body?.group);
    if (!found.ok) return;
    const g = found.value.group;
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
    const found = await requireFeature(res, resolveGroup, name);
    if (!found.ok) return;
    const g = found.value.group;
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
    const found = await requireFeature(res, resolveGroup, req.body?.group);
    if (!found.ok) return;
    const members = found.value.group.members;
    if (!members.length) return res.status(400).json({ error: 'feature has no members' });
    for (const m of members) {
      const s = manager.sessionForWorktree(m.path);
      if (s) return res.json({ ok: true, session: s, existed: true });
    }
    const [primary, ...rest] = members;
    // A repo the scan cache has not seen. The `rest` loop below already skips one; the
    // primary went straight to `pRepo.path`, so the same miss was a TypeError — a 500
    // leaking an internal message where the caller's own 400 belongs. THIS is the site
    // requireRepo() exists for: the guard cannot be forgotten, because `.value` does not
    // exist until the check has narrowed it.
    const pRepo = requireRepo(res, repos(), primary.repo);
    if (!pRepo.ok) return;
    const session = await manager.adopt({
      worktreePath: primary.path,
      repoName: primary.repo,
      repoPath: pRepo.value.path,
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
