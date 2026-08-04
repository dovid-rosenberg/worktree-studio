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
import { run, shq } from './util.ts';

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
  canStart?: boolean;
  /** Why `canStart` is false — see servers.decorate(). Both feed skipReason(). */
  depsMissing?: boolean;
  noStartCmd?: boolean;
  session?: { id: string } | null;
}

/** A member /group/start declined to launch, and the reason a user can act on. */
interface SkippedMember {
  repo: string;
  path: string;
  reason: string;
}

/**
 * Why a member cannot be launched, in words the UI can show verbatim.
 *
 * `canStart` is `configured && !depsMissing` (servers.decorate), so a false value has
 * exactly two causes and both are fixable by the user — one with the Install button,
 * one by adding the repo to `config.start`. Naming them is the whole point: the stack
 * used to drop these members before the launch loop and report the remainder as a
 * complete success.
 */
function skipReason(m: Member): string {
  if (m.depsMissing) return 'dependencies not installed';
  if (m.noStartCmd) return 'no start command configured for this repo';
  return 'cannot start';
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
  startAll(
    targets: Array<{ repo: string; worktreePath: string }>,
  ): Promise<
    | { ok: false; slotError: string }
    | {
        ok: true;
        results: Array<{
          repo: string;
          ok: boolean;
          error?: string;
          listening?: boolean;
          boundElsewhere?: number[];
        }>;
      }
  >;
  stop(repo: string, worktreePath: string): Promise<unknown>;
  // Was `Promise<unknown>` while /group/restart threw the result away and answered a
  // hardcoded `ok: true`. The verdict is only reportable if the type admits it exists.
  restart(repo: string, worktreePath: string, opts: LaunchOpts): Promise<{ ok: boolean; error?: string }>;
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
  cfg: { editors?: Record<string, { open: string; openGroup?: string }>; defaultEditor: string };
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
}

// `app` here is the API router — server.ts mounts it at both /api and /api/v1.
function register(app: Router, deps: OrchestratorDeps): void {
  const {
    cfg,
    servers,
    manager,
    repos,
    resolveGroup,
    conflictsFor,
    refreshRunning,
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
    const toStart = g.members.filter((m) => !m.running && m.canStart);
    /*
     * The members that SHOULD come up and cannot. Previously these were dropped by the
     * same filter that built `toStart` and never mentioned again: a two-repo feature
     * whose BE worktree had no node_modules — the normal state of a fresh `wt`
     * worktree — answered `{ok:true, started:1, total:1, failures:[]}`, which is
     * byte-identical to a full success. Half a stack, reported as a win, with the
     * missing half named nowhere in the response.
     */
    const skipped: SkippedMember[] = g.members
      .filter((m) => !m.running && !m.canStart)
      .map((m) => ({ repo: m.repo, path: m.path, reason: skipReason(m) }));
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
      for (const c of conflicts) await servers.stop(c.repo, c.path);
      await new Promise((r) => setTimeout(r, 1200));
    }
    // Key each slot on the member's own feature identity — the one canonical key.
    // Members of a real feature resolve to the same identity → one slot; under the
    // default `basename` strategy a degenerate mixed-name manual group gets a
    // per-worktree slot each (the `manifest` strategy is what fixes that).
    // Slots first, then launches — servers.startAll owns that sequence for all three
    // routes that need it, so they cannot drift apart again.
    const out = await servers.startAll(toStart.map((m) => ({ repo: m.repo, worktreePath: m.path })));
    if (!out.ok) return res.status(409).json({ ok: false, error: out.slotError });

    let started = 0;
    const failures: Array<{ repo: string; error?: string }> = [];
    for (const r of out.results) {
      if (!r.ok) {
        failures.push({ repo: r.repo, error: r.error });
        continue;
      }
      // Spawned but never bound. This used to count as a start, which is the precise
      // shape of "it said it started and nothing is running": the process was created,
      // so `ok` was true, and whether it survived long enough to listen was never asked.
      if (r.listening === false) {
        // Two very different diagnoses, and the difference is the whole value of the
        // message: a server on an unexpected port is UP and misconfigured (its repo does
        // not read the slot's port env var), where one on no port at all is down.
        failures.push({
          repo: r.repo,
          error: r.boundElsewhere?.length
            ? `started on port ${r.boundElsewhere.join(', ')} instead of the port this feature's slot expects — this repo does not appear to read its configured port env var, so a second feature cannot run it`
            : 'started but no port was listening — check its log',
        });
        continue;
      }
      started++;
    }
    await refreshRunning();
    scheduleBroadcast();
    /*
     * `ok` means what a client keying on it assumes: every member that should be up is
     * up. It was hardcoded true, so a stack where all three members failed to bind
     * answered `{ ok: true, started: 0, failures: [3 things] }` and a client that read
     * only `ok` called total failure a success. Nothing to start is still ok — that is
     * a no-op, not a failure.
     *
     * A skipped member fails it too. Skipping is not a no-op: the user asked for the
     * stack and part of it is not running, for a reason they can fix. `total` counts
     * what should be up rather than what was attempted, so `started/total` can finally
     * show the shortfall — it read `1/1` for a half-started two-repo stack.
     */
    res.json({
      ok: failures.length === 0 && skipped.length === 0,
      started,
      total: toStart.length + skipped.length,
      skipped,
      failures,
    });
  });

  app.post('/group/stop', async (req, res) => {
    const { group }: GroupBody = req.body || {};
    const { group: g } = await resolveGroup(String(group ?? ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    await Promise.all(g.members.filter((m) => m.running).map((m) => servers.stop(m.repo, m.path)));
    // Refresh first, then release: the guard reads what is still listening, and this
    // released the slot BEFORE looking — so a member that refused to die still took its
    // ports while the slot went back in the pool.
    await refreshRunning();
    releaseIdleSlots(g.members);
    scheduleBroadcast();
    res.json({ ok: true });
  });

  app.post('/group/restart', async (req, res) => {
    const { group }: GroupBody = req.body || {};
    const { group: g } = await resolveGroup(String(group ?? ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const toRestart = g.members.filter((m) => m.running || m.canStart);
    // Same omission /group/start had: a member that is neither running nor startable is
    // dropped here too, and a restart that silently brings back less than was asked for
    // is the same lie in a different verb.
    const skipped: SkippedMember[] = g.members
      .filter((m) => !m.running && !m.canStart)
      .map((m) => ({ repo: m.repo, path: m.path, reason: skipReason(m) }));
    for (const m of toRestart) {
      const alloc = servers.allocSlotFor(servers.featureFor(m.path)); // reuse the feature's slot across the restart
      if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    }
    // The results were discarded and `ok` hardcoded true, so a restart where every
    // member failed to rebind reported success.
    const failures: Array<{ repo: string; error?: string }> = [];
    let restarted = 0;
    await Promise.all(
      toRestart.map(async (m) => {
        const r = await servers.restart(
          m.repo,
          m.path,
          servers.launchOpts(m.repo, servers.featureFor(m.path)),
        );
        if (r.ok) restarted++;
        else failures.push({ repo: m.repo, error: r.error });
      }),
    );
    await refreshRunning();
    scheduleBroadcast();
    res.json({
      ok: failures.length === 0 && skipped.length === 0,
      started: restarted,
      total: toRestart.length + skipped.length,
      skipped,
      failures,
    });
  });

  app.post('/group/open', async (req, res) => {
    const { group, editor }: GroupBody = req.body || {};
    const { group: g } = await resolveGroup(String(group ?? ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    // String(): `editor` is whatever the body carried — it can be an array, an object,
    // a number. A property access coerces the key exactly this way already, so naming
    // the coercion cannot change which editor is picked.
    const ed = (cfg.editors && (cfg.editors[String(editor)] || cfg.editors[cfg.defaultEditor])) || null;
    if (!ed) return res.status(400).json({ error: 'no editor configured' });
    const paths = g.members.map((m) => m.path);
    // split/join, never replace(): the shell-quoted path is the REPLACEMENT string, and
    // `$&`, `` $` ``, `$'` and `$$` in a replacement string are expanded by the engine
    // AFTER shq() has done its quoting — so a worktree path containing `$&` would open
    // some other path entirely, quoting notwithstanding. split/join is literal.
    if (ed.openGroup) {
      await run('bash', ['-lc', ed.openGroup.split('{paths}').join(paths.map(shq).join(' '))]);
    } else {
      for (const p of paths) await run('bash', ['-lc', ed.open.split('{path}').join(shq(p))]);
    }
    res.json({ ok: true });
  });

  // Close a feature: stop its servers + deactivate its sessions (keep worktrees).
  app.post('/group/close', async (req, res) => {
    const { group: g } = await resolveGroup(String(req.body?.group ?? ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    for (const m of g.members) {
      if (m.running) await servers.stop(m.repo, m.path);
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
    const { group, deleteBranches }: GroupBody = req.body || {};
    const { group: g } = await resolveGroup(String(group ?? ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const results: Array<{ repo: string; ok: boolean; error?: string }> = [];
    for (const m of g.members) {
      const repoObj = repos().find((r) => r.name === m.repo);
      if (!repoObj) {
        results.push({ repo: m.repo, ok: false, error: 'unknown repo' });
        continue;
      }
      if (m.running) await servers.stop(m.repo, m.path);
      if (m.session) await manager.close(m.session.id);
      const rr = await worktree.remove(repoObj.path, m.path, {
        branch: m.branch,
        deleteBranch: !!deleteBranches,
      });
      results.push({ repo: m.repo, ok: rr.ok, error: rr.ok ? undefined : rr.error });
    }
    // Unconditional, and the ONE place that is right: the worktrees are gone, so the
    // feature no longer exists. Guarding here would leak the slot forever if some stray
    // process were still holding a port from a path that has been deleted.
    for (const m of g.members) servers.releaseSlot(servers.featureFor(m.path));
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
