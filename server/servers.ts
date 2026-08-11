// Dev-server control per worktree. Running state is DISCOVERED by mapping every
// listening socket to the process's cwd → git worktree top-level (like
// worktree-dash's core.sh), so it detects any server in any worktree — not only
// ones on a configured port. Configured `start[repo]` is used only to launch.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { CHILD_ENV, run, readJsonState, writeJson, realpath, slug } from './util.ts';
import { deriveEnv, allocSlot, rewriteAllSiblingPorts } from './concurrency.ts';
import { createIdentity } from './identity.ts';
import type { Identity } from './identity.ts';
import type { ConcurrencyConfig, Config, PartialDeep, RepoConcurrency, Worktree } from './types.ts';
import { TAIL_MAX_BYTES, readTail, tailFile } from './log-tail.ts';

/**
 * The config `Servers` reads.
 *
 * `PartialDeep<Config>` for everything it reads defensively (server.ts hands it a
 * whole config, every test hands it three keys), plus `concurrency` in its real
 * shape: the entries of `concurrency.repos` go straight to server/concurrency.ts,
 * which reads `portEnv[key]` as a number rather than re-checking each one.
 */
export type ServersConfig = PartialDeep<Config> & { concurrency?: ConcurrencyConfig };

/**
 * One launched dev server, as it is written to servers.json — and as it is read
 * back, which is not the same thing: the file outlives upgrades, so a record may
 * predate any field added since it was written.
 */
export interface TrackedServer {
  /** Absent when spawn() never produced one. */
  pid?: number;
  repo?: string;
  log?: string;
  /** Absent in records written before the recycled-pid check existed — see _trackedPidState. */
  startedAt?: number;
}

export type TrackedMap = Record<string, TrackedServer>;

/**
 * servers.json as it is read back. `tracked`/`slots` is today's shape; the index
 * signature is the old flat file, whose keys are worktree paths.
 */
interface SavedServers {
  tracked?: TrackedMap;
  slots?: Record<string, unknown>;
  [worktreePath: string]: unknown;
}

/** What a tracked record's pid names right now — see _trackedPidState. */
export type TrackedPidState = 'ours' | 'gone' | 'stranger';

/** A live process, as `ps` reports it. */
export interface PsInfo {
  startedAt: number;
  command: string;
}

/** A listening process's cwd and the git worktree it resolves to. */
export interface PidInfo {
  cwd: string;
  /** realpath of the git worktree top-level. */
  top: string;
}

/**
 * A cached PidInfo, plus the start time of the process it was resolved for.
 *
 * The start time is what makes the entry belong to a PROCESS rather than to a number —
 * see _pidInfoCache. Optional because `ps` can lose the race with a process that exits
 * between the LISTEN scan and the lookup; an entry with no stamp simply never validates
 * and is re-resolved, which costs a scan and cannot be wrong.
 */
interface CachedPidInfo extends PidInfo {
  startedAt?: number;
}

/** One discovered dev server: the listening pid and every non-ephemeral port it holds. */
export interface RunningServer {
  pid: number;
  ports: number[];
}

/** A repo's launch command, once the string and object forms have been reconciled. */
export interface StartCommand {
  cmd: string;
  ports: number[];
}

/** A slot, or why there isn't one. */
export type SlotAllocation = { slot: number; error?: undefined } | { slot?: undefined; error: string };

/**
 * A config rewrite start() applies before spawning: which file, which sibling port
 * families to shift, and to which slot. Distinct from the config's own
 * `ConfigPatch`, which names the sibling REPO rather than its resolved ports.
 */
export interface ConfigPatchPlan {
  file: string;
  siblingPortEnv: Record<string, number>;
  slot: number;
}

/** Launch env + ports for a repo at a feature's slot. */
export interface LaunchOpts {
  env: Record<string, string>;
  ports: number[];
  /**
   * Already-substituted text to append to the start command — see RepoConcurrency.portFlag.
   * Resolved in launchOpts() rather than here so start() stays a launcher and does not
   * need to know what a concurrency slot is.
   */
  portArgs?: string;
  patch?: ConfigPatchPlan;
  /**
   * Run THIS command instead of the repo's configured one.
   *
   * For a run configuration of `kind: 'server'` — a long-lived process the user picked
   * from their editor's configs. It gets the same treatment as a dev server (tracked pid,
   * log file, port poll, reachable by Stop stack) because that is what it is; only the
   * command differs. Without this the only launchable command per repo is `config.start`.
   */
  cmd?: string;
}

/**
 * `ok` is "the launch was accepted", not "the server answered".
 *
 * `listening` is the stronger claim, and it is deliberately three-valued: true when
 * every expected port bound inside the poll window, false when the window expired with
 * one still down, and undefined when there was nothing to check — a repo whose ports
 * are not knowable (the string form of `config.start` with no concurrency entry) can
 * only be spawned, never verified. Collapsing "unverified" into "listening" is what let
 * a stack report success for a server that never came up.
 */
export type StartResult =
  | { ok: false; error: string }
  | {
      ok: true;
      pid?: number;
      log: string;
      listening?: boolean;
      /**
       * Set only when `listening` is false AND the worktree turned out to be listening
       * on something else: the ports it actually bound.
       *
       * This is the signature of a concurrency slot the repo does not implement. Studio
       * derives a per-slot port from `concurrency.repos[repo].portEnv` and passes it as
       * an env var; a repo that never reads that variable binds its hardcoded port on
       * every slot. The result is a dev server that is genuinely up, on a port Studio is
       * not watching — which looks identical to one that died, and silently defeats
       * running two features at once. Naming both numbers is what tells them apart.
       */
      boundElsewhere?: number[];
    };

/**
 * What a stop demonstrated.
 *
 * `ok` is a constant — a stop is always attempted. `stillListening` is the real verdict:
 * the ports that were still bound after SIGTERM, a settle and SIGKILL.
 */
export interface StopResult {
  ok: true;
  killed: boolean;
  stillListening: number[];
}

/** A record pruneTracked() dropped, for the boot-time log. */
export interface DroppedRecord {
  worktreePath: string;
  pid?: number;
}

export interface LogsOptions {
  offset?: number;
  lines?: number;
}

export interface LogTail {
  /** The byte position to pass to the next call. */
  offset: number;
  text: string;
  size: number;
  /** How many bytes the read cap dropped (0 normally). */
  skipped: number;
}

const ENV = CHILD_ENV;
const EPHEMERAL = 49152; // ports at/above this are ephemeral — ignore

// How far a process's real start time may sit from the moment we recorded spawning
// it. `ps -o lstart=` has one-second resolution and we stamp the record either side
// of the spawn, so a few seconds of slack is required; a pid the OS handed to
// somebody else is off by hours, or by a reboot.
const PID_START_SKEW_MS = 10000;

// How long start() and stop() wait for the other's per-worktree lock before giving up on
// it — see _lock, and stop() for the interleave this closes.
//
// Deliberately SHORTER than a launch: start() holds the lock for as long as its port poll
// runs, up to ~8 s. So two launches of one worktree still refuse each other exactly as
// they always have, while a Stop followed by a Start — a sequence a user performs in well
// under a second, and the one that orphaned servers — simply queues. And it is a wait,
// not a gate: a stop the user asked for must happen even if the wait expires, because the
// alternative is a Stop button that reports failure and leaves the server up.
const LOCK_WAIT_MS = 2000;

// Feature identity of a worktree, from a path alone. Kept as a free function for
// the callers that have nothing but a path and no resolver to hand; it answers
// with the default (`basename` strategy, `.worktrees` layout) convention. A
// Servers instance uses ITS OWN configured resolver (`this.identity`) instead, so
// slot keys always match the grouping in server/features.ts.
const DEFAULT_IDENTITY = createIdentity({});
function featureFromPath(worktreePath: string): string {
  return DEFAULT_IDENTITY.ofPath(worktreePath);
}

// Dev-server logs are appended to for the life of the worktree, so both their size
// and what a single read of one may cost have to be bounded — and the read matters
// more than the size. `logs()` runs on the event loop that also serves the terminal
// WebSockets and the SSE fan-out, so a synchronous read of a vite/webpack log left
// growing for days blocked all of it for seconds, or threw ERR_STRING_TOO_LONG once
// the file passed ~512 MB. Three ceilings:
//   MAX_LOG_BYTES   the file is trimmed back to KEEP_LOG_BYTES once it passes this
//   KEEP_LOG_BYTES  how much history a trim keeps
//   TAIL_MAX_BYTES  the most any single read may pull into memory
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const KEEP_LOG_BYTES = 4 * 1024 * 1024;

// Trim a log back to its last `keep` bytes once it passes `max`. Returns whether
// it did anything.
//
// In place, deliberately — NOT rename-and-reopen. The dev server holds a descriptor
// this daemon handed it on this exact inode, so renaming would only move the file it
// keeps writing to and leave the new one empty forever. That descriptor was opened
// 'a' (O_APPEND), which makes every write seek to the CURRENT end, so shrinking the
// file under a running child is safe: it appends after the kept tail instead of
// leaving a sparse hole. A write landing between the read and the truncate is lost —
// acceptable for a log, and the alternative is unbounded growth.
function trimLog(file: string, max = MAX_LOG_BYTES, keep = KEEP_LOG_BYTES): boolean {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size <= max) return false;
  let fd: number;
  try {
    fd = fs.openSync(file, 'r+');
  } catch {
    return false;
  }
  try {
    const want = Math.min(keep, size); // a keep larger than the file would read from a negative offset
    const buf = Buffer.alloc(want);
    const n = fs.readSync(fd, buf, 0, want, size - want);
    const nl = buf.subarray(0, n).indexOf(0x0a); // resume on a line boundary
    const from = nl >= 0 && nl + 1 < n ? nl + 1 : 0;
    fs.writeSync(fd, buf, from, n - from, 0);
    fs.ftruncateSync(fd, n - from);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

class Servers {
  cfg: ServersConfig;
  identity: Identity;
  selfPort: number;
  logDir: string;
  lockDir: string;
  file: string;
  tracked: TrackedMap;
  slots: Map<string, number>;
  _pidInfoCache: Map<string, CachedPidInfo>;
  _starting: Map<string, number>;

  // `identity` is the shared server/identity.ts resolver (server.ts builds one and
  // hands the same instance to state.ts/orchestrator.ts). Passing it is what makes
  // "which feature is this worktree?" one answer instead of two.
  constructor(cfg: ServersConfig, identity?: Identity | null) {
    this.cfg = cfg;
    this.identity = identity || createIdentity(cfg);
    this.selfPort = cfg.web?.port || 0;
    // config.ts stamps `_stateDir` onto every config it loads and every caller passes
    // one; a config without it never reached this line, because path.join() threw on it.
    const stateDir = cfg._stateDir!;
    this.logDir = path.join(stateDir, 'logs');
    this.lockDir = path.join(stateDir, 'locks');
    this.file = path.join(stateDir, 'servers.json');
    fs.mkdirSync(this.logDir, { recursive: true });
    fs.mkdirSync(this.lockDir, { recursive: true });
    // servers.json shape: { tracked: { worktreePath → { pid, repo, log } }, slots: { feature → slot } }.
    // Back-compat: an old flat file (just the tracked object) still loads as `tracked`.
    // readJsonState: a corrupt servers.json is kept aside, not overwritten (see util.ts).
    const saved = readJsonState<SavedServers>(this.file, {});
    this.tracked = (saved.tracked || saved) as TrackedMap; // worktreePath → { pid, repo, log }
    // featureName → slot (concurrency: one slot per feature, shared by its repos). Persisted
    // so a Studio restart while features run doesn't re-slot a running feature to slot 0.
    this.slots = new Map(Object.entries(saved.slots || {}).map(([k, v]): [string, number] => [k, Number(v)]));
    // pid (string) → { cwd, top, startedAt } — a process's cwd/git-toplevel never change,
    // so we resolve each listening pid once and reuse it across discoverRunning scans.
    // The start time rides along because the PID does not identify the process: see
    // discoverRunning for the reuse this guards against.
    this._pidInfoCache = new Map();
    // feature → number of launches currently in flight. start() polls up to ~8 s for
    // ports to bind, and the periodic sweep runs every ~3 s, so a feature that is
    // slow to come up looks exactly like a dead one to reconcileSlots() — "nothing
    // is listening" is the normal state DURING a launch. Without this, its slot gets
    // reclaimed mid-launch and handed to the next feature, which then binds the same
    // ports. Counted rather than a flag because a multi-repo feature launches all of
    // its members concurrently, each entering and leaving independently.
    // Deliberately in-memory: a launch cannot outlive the process that is polling it,
    // so persisting this could only ever resurrect a guard for a start that is over.
    this._starting = new Map();
  }

  _save(): void {
    writeJson(this.file, { tracked: this.tracked, slots: Object.fromEntries(this.slots) });
  }

  // The feature a worktree path belongs to, under the configured identity
  // strategy. Every slot key in the app goes through here or through
  // `identity.of()` on the equivalent worktree object — the two agree by
  // construction (server/identity.ts).
  featureFor(worktreePath: string): string {
    return this.identity.ofPath(worktreePath);
  }

  // ---- concurrency: per-feature slot allocation + derived launch env ----
  _concEnabled(): boolean {
    return !!this.cfg.concurrency?.enabled;
  }
  _repoConc(repo: string): RepoConcurrency | null {
    const c = this.cfg.concurrency;
    return c?.repos?.[repo] || null;
  }
  // A repo that gets a concurrency slot runs on its own (offset) ports per feature,
  // so running it in two worktrees at once does NOT collide.
  isSlotted(repo: string): boolean {
    return this._concEnabled() && !!this._repoConc(repo);
  }

  // Allocate (or reuse) the slot for a feature. Returns { slot } or { error } when
  // all slots are busy. Slot 0 semantics when concurrency is off / no feature name.
  allocSlotFor(feature: string): SlotAllocation {
    const conc = this.cfg.concurrency;
    // Without a concurrency block `_concEnabled()` is already false, so the second
    // test is that same condition restated where the type checker can see it.
    if (!this._concEnabled() || !conc || !feature) return { slot: 0 };
    const held = this.slots.get(feature);
    if (held !== undefined) return { slot: held };
    const max = conc.maxSlots || 1;
    const slot = allocSlot(new Set(this.slots.values()), max);
    if (slot === null) return { error: `no free concurrency slot (max ${max} running)` };
    this.slots.set(feature, slot);
    this._save();
    return { slot };
  }

  releaseSlot(feature: string): void {
    if (feature && this.slots.delete(feature)) this._save();
  }

  /**
   * Release a feature's slot only if nothing of that feature is still listening.
   *
   * The safe form of releaseSlot, and the only one callers should reach for. Three routes
   * used to free slots three different ways: `/servers/stop` guarded on this condition,
   * while `/sessions/:id/servers/stop` and `/group/stop` released unconditionally once
   * they had stopped what THEY knew about.
   *
   * Unconditional release is only correct if the caller stopped every member of the
   * feature, and a caller cannot assume that. A session's `repos` can be a strict subset
   * of its feature's members — a worktree made with a plain `wt` joins the feature but
   * not the session — so stopping the session's repos can leave a sibling running. The
   * slot then goes back in the pool, the next feature is handed it, and both bind the
   * same ports.
   *
   * `running` is the discovered map (realpath → {pid,ports}) from discoverRunning();
   * callers pass the cache they have just refreshed.
   */
  releaseSlotIfIdle(feature: string, running: Map<string, RunningServer>): boolean {
    if (!feature) return false;
    for (const p of running.keys()) if (this.featureFor(p) === feature) return false;
    this.releaseSlot(feature);
    return true;
  }

  // Mark a feature as having a launch in flight, so its slot is not reclaimable
  // while its ports are still coming up. Always paired in a finally.
  _beginStart(feature: string): void {
    if (!feature) return;
    this._starting.set(feature, (this._starting.get(feature) || 0) + 1);
  }

  _endStart(feature: string): void {
    if (!feature) return;
    const left = (this._starting.get(feature) || 0) - 1;
    if (left > 0) this._starting.set(feature, left);
    else this._starting.delete(feature);
  }

  // Is a launch for this feature in flight right now?
  isStarting(feature: string): boolean {
    return this._starting.has(feature);
  }

  // Self-heal the slot map against reality: drop any slot whose feature has no
  // running worktree in `runningMap` (Map(realpath → {pid,ports}) from discoverRunning).
  // Called on the periodic refresh so leaked/stale slots are released and a
  // restart-with-running-servers keeps only the slots that are actually live.
  //
  // "Reality" here is what is LISTENING, and a feature that is still starting is
  // legitimately not listening yet — see `_starting`. Reclaiming its slot would
  // hand the ports it is about to bind to somebody else.
  reconcileSlots(runningMap: Map<string, RunningServer>): void {
    let changed = false;
    for (const feature of [...this.slots.keys()]) {
      if (this._starting.has(feature)) continue; // launch in flight — not yet up ≠ gone
      if (![...runningMap.keys()].some((p) => this.featureFor(p) === feature)) {
        this.slots.delete(feature);
        changed = true;
      }
    }
    if (changed) this._save();
  }

  // Launch env + ports for a repo at a feature's current slot. {} / [] when
  // concurrency is off or the repo has no concurrency config (behaves as today).
  // When the repo declares a `configPatch` (e.g. an FE that hardcodes its backend's
  // ports), return a `patch` descriptor that start() applies to the worktree's config
  // file — shifting ALL of the sibling repo's port families to this feature's slot.
  launchOpts(repo: string, feature: string): LaunchOpts {
    const conc = this.cfg.concurrency;
    // As in allocSlotFor: no concurrency block means `_concEnabled()` already said no.
    if (!this._concEnabled() || !conc) return { env: {}, ports: [] };
    const rc = this._repoConc(repo);
    if (!rc) return { env: {}, ports: [] };
    const step = conc.offsetStep;
    const slot = this.slots.get(feature) ?? 0;
    const { env, ports } = deriveEnv(rc, slot, step);
    // The flag half of the same idea: a dev server that cannot read portEnv usually
    // takes the port on the command line. Empty when unconfigured or when this repo
    // derives no ports, so an unconcerned repo's command is untouched.
    const portArgs = rc.portFlag && ports.length ? rc.portFlag.split('{port}').join(String(ports[0])) : '';
    const cp = rc.configPatch;
    if (cp) {
      const sib = this._repoConc(cp.siblingRepo);
      const siblingPortEnv = sib?.portEnv;
      if (siblingPortEnv) return { env, ports, portArgs, patch: { file: cp.file, siblingPortEnv, slot } };
    }
    return { env, ports, portArgs };
  }

  // Rewrite a worktree's gitignored FE config to point at this slot's sibling ports.
  // Shifts every one of the sibling repo's port families (su/merchant/iso/…) uniformly.
  // Best-effort + file-exists guarded: silently no-op when the file isn't present.
  applyConfigPatch(worktreePath: string, patch?: ConfigPatchPlan | null): void {
    if (!patch?.file) return;
    try {
      const file = path.join(worktreePath, patch.file);
      if (!fs.existsSync(file)) return;
      const conc = this.cfg.concurrency;
      if (!conc) return; // no concurrency block → nothing to shift the ports to
      const step = conc.offsetStep;
      const max = conc.maxSlots || 1;
      const text = fs.readFileSync(file, 'utf8');
      const out = rewriteAllSiblingPorts(text, patch.siblingPortEnv, step, max, patch.slot);
      if (out !== text) fs.writeFileSync(file, out);
    } catch {
      /* best-effort — never block a launch on a config rewrite */
    }
  }

  startCfg(repo: string): StartCommand | null {
    const s = this.cfg.start && Object.hasOwn(this.cfg.start, repo) ? this.cfg.start[repo] : null;
    if (!s) return null;
    if (typeof s === 'string') return { cmd: s, ports: [] };
    // An entry with no `cmd` is not a launchable config: canStart would advertise one
    // and start() would then hand `undefined` to spawn(). POST /settings drops such
    // rows, but a hand-edited config.json can still carry one.
    if (!s.cmd) return null;
    return { cmd: s.cmd, ports: s.ports || [] };
  }

  alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // { startedAt, command } for a live pid, or null when there is no such process.
  // `lstart` is a fixed-width ctime string — "Mon Jul 27 22:46:40 2026", 24 chars —
  // so the command is simply the rest of the line.
  async _psInfo(pid: number): Promise<PsInfo | null> {
    const r = await run('ps', ['-o', 'lstart=,command=', '-p', String(pid)], { env: ENV });
    const line = (r.stdout || '').split('\n').find((l) => l.trim());
    if (!line) return null;
    const at = Date.parse(line.slice(0, 24));
    if (!Number.isFinite(at)) return null;
    return { startedAt: at, command: line.slice(24).trim() };
  }

  // What a tracked record's pid actually names right now:
  //   'ours'     — still the process we launched, safe to signal
  //   'gone'     — no such process; the record is simply stale
  //   'stranger' — a live process that is NOT ours (the pid was recycled)
  //
  // This exists because `tracked` is persisted to servers.json and survives daemon
  // restarts AND reboots, while nothing ever pruned it. `alive(pid)` only proves
  // SOME process holds the number — and pids restart low after a reboot, so
  // collision is ordinary rather than exotic. stop() then sent SIGTERM to the whole
  // process GROUP of whatever now owned it, and stop() is reached with no running
  // check at all from DELETE /sessions/:id and POST /sessions/:id/servers/stop.
  // A process's start time is fixed at exec and cannot be inherited with the pid,
  // which is what makes the record self-validating.
  // `worktreePath` is the path the record is filed under. Only the legacy branch needs
  // it, and only to answer "is this pid living in THAT worktree" — see below.
  async _trackedPidState(t?: TrackedServer | null, worktreePath?: string): Promise<TrackedPidState> {
    if (!t?.pid) return 'gone';
    const info = await this._psInfo(t.pid);
    if (!info) return 'gone';
    if (t.startedAt) return Math.abs(info.startedAt - t.startedAt) <= PID_START_SKEW_MS ? 'ours' : 'stranger';
    // Records written before `startedAt` existed — servers.json outlives upgrades.
    // Fall back to the command we would have launched for that repo: weaker than a
    // start time, but it still tells a dev server from someone else's daemon, and
    // it is strictly better than trusting the bare number.
    const sc = t.repo ? this.startCfg(t.repo) : null; // a record with no repo has no command to match either
    if (!sc?.cmd || !info.command.includes(sc.cmd)) return 'stranger';
    /*
     * The command is not an identity. Two worktrees of one repo run the SAME
     * `bash -lc npm run dev`, byte for byte, so a recycled pid that now belongs to a
     * sibling worktree's dev server passed the command test and was blessed as ours —
     * and stop() then SIGTERMed its whole process group, taking down a feature the user
     * was working in and had not touched. Where the process actually lives is the part
     * that differs between the two, so that is what has to agree.
     *
     * A pid we cannot place — no cwd, or a cwd outside any git worktree — is somebody
     * else's, and so is a record filed under no path at all: neither can be shown to be
     * ours, and this decides who gets signalled.
     */
    if (!worktreePath) return 'stranger';
    const where = await this._resolvePid(String(t.pid));
    return where && where.top === realpath(worktreePath) ? 'ours' : 'stranger';
  }

  // Drop every tracked record that no longer names a process we launched. Called at
  // boot, which is where the damage was: the map accumulated across restarts and
  // reboots, so entries written days ago were still live kill targets.
  async pruneTracked(): Promise<DroppedRecord[]> {
    const dropped: DroppedRecord[] = [];
    for (const [wt, t] of Object.entries(this.tracked)) {
      if ((await this._trackedPidState(t, wt)) === 'ours') continue;
      dropped.push({ worktreePath: wt, pid: t.pid });
      delete this.tracked[wt];
    }
    if (dropped.length) this._save();
    return dropped;
  }

  async portPid(port: number): Promise<number | null> {
    const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { env: ENV });
    const pid = r.stdout.trim().split('\n').filter(Boolean)[0];
    return pid ? Number(pid) : null;
  }

  // Parse `lsof -Fpn` LISTEN output into Map(pid(string) → Set(port:int)),
  // filtering ephemeral ports and Studio's own port.
  async _listeningPids(): Promise<Map<string, Set<number>>> {
    const byPid = new Map<string, Set<number>>();
    const r = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { env: ENV });
    if (r.code !== 0 && !r.stdout) return byPid;
    // parse -F output: `p<pid>` starts a process block; `n<host>:<port>` are its sockets
    let pid: string | null = null;
    for (const line of r.stdout.split('\n')) {
      if (line[0] === 'p') {
        pid = line.slice(1);
        if (!byPid.has(pid)) byPid.set(pid, new Set());
      } else if (line[0] === 'n' && pid) {
        const m = line.slice(1).match(/:(\d+)$/);
        if (m) {
          const port = Number(m[1]);
          // The `p` line that opened this block seeded the entry, so the lookup holds.
          if (port < EPHEMERAL && port !== this.selfPort) byPid.get(pid)?.add(port);
        }
      }
    }
    return byPid;
  }

  // Resolve one pid → { cwd, top(=realpath git worktree top-level) }, or null if it
  // isn't inside a git worktree. The two lsof/git spawns here are what the per-pid
  // cache in discoverRunning elides on subsequent scans.
  async _resolvePid(pid: string): Promise<PidInfo | null> {
    const c = await run('lsof', ['-p', pid, '-a', '-d', 'cwd', '-Fn'], { env: ENV });
    const cwdLine = c.stdout.split('\n').find((l) => l[0] === 'n');
    if (!cwdLine) return null;
    const cwd = cwdLine.slice(1);
    const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { env: ENV });
    if (top.code !== 0) return null;
    return { cwd, top: realpath(top.stdout.trim()) };
  }

  // Map every LISTEN socket → owning process cwd → git worktree top-level.
  // Returns Map(realpath(worktreeTopLevel) → { pid, ports:[int] }).
  // Per-pid cwd/toplevel resolution is cached (a process's cwd never changes), so
  // steady-state scans only re-run the single LISTEN lsof, not a git+lsof per pid.
  async discoverRunning(): Promise<Map<string, RunningServer>> {
    const out = new Map<string, RunningServer>();
    const byPid = await this._listeningPids();
    for (const [p, ports] of byPid) {
      if (!ports.size) continue;
      let info: CachedPidInfo | null | undefined = this._pidInfoCache.get(p);
      if (info) {
        /*
         * A cache entry belongs to a PROCESS, not to a number.
         *
         * This was keyed on the pid alone and evicted only when the pid stopped
         * appearing in the LISTEN scan — so a dev server that exited and had its pid
         * handed straight to an unrelated listener before the next sweep was reported as
         * the OLD worktree, running on the stranger's ports. The row showed a live Stop
         * button for a server that was gone, and reconcileSlots kept the feature's slot
         * held forever because something was always "listening" for it.
         *
         * The start time is fixed at exec and cannot be inherited with the pid, which is
         * what makes it the thing to compare — the same property that makes a tracked
         * record self-validating in _trackedPidState.
         */
        const now = await this._psInfo(Number(p));
        if (!now || now.startedAt !== info.startedAt) {
          this._pidInfoCache.delete(p);
          info = null;
        }
      }
      if (!info) {
        const resolved = await this._resolvePid(p);
        if (!resolved) continue; // not in a git worktree — retry next scan (don't cache misses)
        // Stamped AFTER the resolve, so the stamp describes the process the cwd was read
        // from rather than one that has since taken its place.
        info = { ...resolved, startedAt: (await this._psInfo(Number(p)))?.startedAt };
        this._pidInfoCache.set(p, info);
      }
      const key = info.top;
      const cur: RunningServer = out.get(key) || { pid: Number(p), ports: [] };
      cur.ports = [...new Set([...cur.ports, ...ports])].sort((a, b) => a - b);
      out.set(key, cur);
    }
    // drop cache entries for pids that are no longer listening
    for (const p of [...this._pidInfoCache.keys()]) if (!byPid.has(p)) this._pidInfoCache.delete(p);
    return out;
  }

  /**
   * Worktrees with an install running right now.
   *
   * In memory, not in servers.json: an install that was interrupted by a daemon
   * restart is finished or dead either way, and a persisted "installing" flag would
   * outlive the process that set it and permanently disable the button.
   */
  installing = new Set<string>();

  /**
   * Install a worktree's dependencies.
   *
   * `git worktree add` cannot bring node_modules across — the directory is gitignored —
   * so every worktree this app creates starts unable to run its own dev server. This is
   * the button that fixes it, rather than making promote itself slow for the cases that
   * do not need it.
   *
   * Logs beside the dev-server logs so a failed install is readable in the same place,
   * and resolves when npm exits so the caller can report a real outcome.
   */
  async installDeps(worktreePath: string): Promise<{ ok: boolean; error?: string; log?: string }> {
    if (!worktreePath || !fs.existsSync(worktreePath)) return { ok: false, error: 'no such worktree' };
    if (!fs.existsSync(path.join(worktreePath, 'package.json')))
      return { ok: false, error: 'no package.json here' };
    if (this.installing.has(worktreePath)) return { ok: false, error: 'already installing' };

    this.installing.add(worktreePath);
    /*
     * One log per WORKTREE, not per worktree name.
     *
     * This was `install__${basename}`, and a multi-repo feature's worktrees share a
     * basename by construction — that is what makes them one feature. So installing the
     * two halves of a stack (which the UI offers as one click per member) interleaved
     * both npm runs into a single file, and each one's trimLog could truncate the other's
     * output mid-install. The log of a failed install is the only place its reason
     * appears, and it was the one thing being scrambled.
     *
     * Named by path the same way _lock is: a slug for a human to read, plus a hash of the
     * full path so distinct worktrees can never land on one file. start() disambiguates
     * with the repo instead, which is not available here — installDeps is handed a path
     * and nothing else.
     */
    const stem = `${slug(path.basename(worktreePath), 40)}-${crypto.createHash('sha1').update(String(worktreePath)).digest('hex').slice(0, 8)}`;
    const log = path.join(this.logDir, `install__${stem}.log`);
    try {
      trimLog(log);
      const fd = fs.openSync(log, 'a');
      let child: ChildProcess;
      try {
        fs.writeSync(fd, `\n===== ${new Date().toISOString()} :: npm install @ ${worktreePath} =====\n`);
        child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
          cwd: worktreePath,
          stdio: ['ignore', fd, fd],
          env: ENV,
        });
      } finally {
        fs.closeSync(fd);
      }

      const code = await new Promise<number>((resolve) => {
        child.once('error', () => resolve(-1));
        child.once('exit', (c) => resolve(c ?? -1));
      });
      if (code !== 0) return { ok: false, error: `npm install exited ${code}`, log };
      return { ok: true, log };
    } catch (e) {
      return { ok: false, error: (e as Error).message, log };
    } finally {
      this.installing.delete(worktreePath);
    }
  }

  /**
   * The directory this worktree's `node_modules` really resolves to, when that is not
   * inside the worktree — else null.
   *
   * The cheap answer to the problem depsMissing() describes: instead of installing,
   * symlink the main checkout's node_modules in. Dependencies resolve, the dev server
   * starts, depsMissing() is correctly false — and the worktree is no longer isolated
   * in the one place tools actually write. Everything that caches inside node_modules
   * now shares one directory: two Vite servers take turns re-optimising
   * `node_modules/.vite/deps` over each other and full-reload the browser to recover,
   * and an `npm install` on this branch rewrites the tree every other worktree of the
   * repo is running against.
   *
   * Reported rather than inferred, because nothing else can see it. Every symptom
   * appears in a different worktree than the cause, and the only local evidence is an
   * lstat that no part of a normal session performs.
   *
   * Resolved before comparing: `ln -s ../../node_modules` is the form these actually
   * take. A link that lands back inside the worktree isolates as well as a real
   * directory and is not flagged, and a dangling one resolves to nothing — that is
   * depsMissing()'s story, and naming a target that is not there would explain nothing.
   */
  sharedModules(worktreePath: string): string | null {
    try {
      const link = path.join(worktreePath, 'node_modules');
      if (!fs.lstatSync(link).isSymbolicLink()) return null;
      if (!fs.existsSync(link)) return null; // dangling
      const target = realpath(link);
      const here = realpath(worktreePath);
      return target === here || target.startsWith(here + path.sep) ? null : target;
    } catch {
      // No node_modules, or a path we cannot stat. Neither is a claim this can make.
      return null;
    }
  }

  /**
   * Whether this worktree is missing the dependencies its start command needs.
   *
   * A worktree created by `git worktree add` has the repo's files and none of its
   * node_modules — the directory is gitignored, so it does not come across. The start
   * command then dies the instant it is invoked, and for a multi-repo feature that means
   * one half comes up and the other does not: the stack looks half-broken for a reason
   * nothing on screen mentions.
   *
   * Deliberately narrow: only a package.json without node_modules. It is not a general
   * "will this run" oracle — no such thing exists — it is the one predictable
   * consequence of how worktrees are made.
   */
  depsMissing(worktreePath: string): boolean {
    try {
      const pkgPath = path.join(worktreePath, 'package.json');
      if (!fs.existsSync(pkgPath)) return false;
      if (fs.existsSync(path.join(worktreePath, 'node_modules'))) return false;
      /*
       * A package with NO dependencies is not missing any.
       *
       * This was exactly "package.json exists && node_modules does not" — but npm only
       * creates node_modules when there is something to install. So a repo whose
       * package.json is just a name and a `start` script was permanently undeployable:
       * the stack refused with "dependencies not installed", the Install button ran npm,
       * npm said "up to date" and created nothing, and the predicate stayed true. An
       * unsatisfiable instruction, repeatable forever — only `mkdir node_modules` broke it.
       */
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const declared = ['dependencies', 'devDependencies', 'optionalDependencies'].some(
        (k) => pkg?.[k] && Object.keys(pkg[k]).length > 0,
      );
      return declared;
    } catch {
      // Unparseable package.json: not a claim we can make either way, and blocking the
      // start on a JSON syntax error would be a confusing place to learn about it.
      return false;
    }
  }

  // Attach running/pid/ports/canStart to a worktree object using a discovered map.
  /**
   * A running server that is on NONE of the ports its feature's slot expects — the ports
   * it is on instead. `[]` when it is where it should be, when the repo has no
   * concurrency mapping, or when nothing is running.
   *
   * discoverRunning() has always FOUND these: it maps any listening socket to its
   * worktree, so a server started with a bare `npm run dev` outside Studio shows as
   * running like any other. What could not be said is that it never read the slot env,
   * bound the repo's hardcoded default, and is now sitting on the port the next feature
   * to start will ask for. start() answers this for launches Studio made — see
   * `boundElsewhere` — and this is the same question for a launch it merely discovered.
   *
   * "None of them" and not "any unexpected port", deliberately: a dev server
   * legitimately opens more sockets than it was asked to (HMR, inspector), and flagging
   * those would fire on every healthy server. Being on the slot AT ALL is what proves
   * the env was read.
   */
  offSlotPorts(worktree: Pick<Worktree, 'path' | 'repo'>, hit: RunningServer | undefined): number[] {
    if (!hit?.ports?.length) return [];
    if (!this.isSlotted(worktree.repo)) return []; // no mapping → no slot to miss
    const { ports } = this.launchOpts(worktree.repo, this.featureFor(worktree.path));
    if (!ports.length) return [];
    return ports.some((p) => hit.ports.includes(p)) ? [] : [...hit.ports];
  }

  decorate(
    worktree: Pick<Worktree, 'path' | 'repo'>,
    running: Map<string, RunningServer>,
  ): Pick<
    Worktree,
    | 'running'
    | 'pid'
    | 'ports'
    | 'canStart'
    | 'depsMissing'
    | 'depsInstalling'
    | 'noStartCmd'
    | 'gone'
    | 'offSlot'
    | 'sharedModules'
  > {
    const hit = running.get(realpath(worktree.path));
    /*
     * A worktree that is no longer on disk cannot start anything.
     *
     * git's `worktree list` keeps reporting a directory somebody deleted until the repo
     * is pruned, and nothing in the topology build checked. depsMissing() made it worse
     * by design: its first line returns `false` for a path with no package.json, which
     * for a VANISHED directory reads as "dependencies are fine". So the row rendered
     * with canStart:true and a live Run button — and pressing it spawned into a cwd that
     * does not exist, which is precisely how one HTTP request killed the daemon.
     */
    const gone = !fs.existsSync(worktree.path);
    const deps = this.depsMissing(worktree.path);
    const configured = !!this.startCfg(worktree.repo);
    return {
      running: !!hit,
      pid: hit ? hit.pid : null,
      ports: hit ? hit.ports : [],
      // `canStart` used to mean "a start command is configured", so it stayed true for a
      // worktree that could not possibly start. Every caller reads it as "starting this
      // will work" — /group/start filters `toStart` on it — so it now means that.
      canStart: configured && !deps && !gone,
      gone,
      depsMissing: deps,
      depsInstalling: this.installing.has(worktree.path),
      /*
       * Why `canStart` is false, for the half that could not say so.
       *
       * Missing deps already explain themselves with a pill. A missing start command
       * did not: the repo is simply absent from `config.start`, the button does not
       * render, and nothing on screen says why. Diagnosing it took an API query, and
       * the natural guess ("stale deps") was wrong. Reporting the other half lets the
       * absent button carry a reason.
       */
      noStartCmd: !configured,
      offSlot: this.offSlotPorts(worktree, hit),
      // Not a reason canStart is false: a shared node_modules starts perfectly well.
      // It is the reason two worktrees that each look fine interfere with each other.
      sharedModules: gone ? null : this.sharedModules(worktree.path),
    };
  }

  // Serialize concurrent launches of the SAME worktree (not the same repo — two
  // worktrees of one repo must start concurrently). Lock name is a filesystem-safe
  // slug + hash of the worktree path so distinct paths never share a lock.
  _lock(worktreePath: string): string | null {
    const name = `${slug(worktreePath, 40)}-${crypto.createHash('sha1').update(String(worktreePath)).digest('hex').slice(0, 8)}`;
    const lock = path.join(this.lockDir, `${name}.lock`);
    try {
      fs.mkdirSync(lock);
      return lock;
    } catch {
      // stale lock (>60s) → reclaim
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 60000) {
          /*
           * CLAIM it, don't just return it.
           *
           * This returned the path having changed nothing, so the lock stayed stale and
           * a second launch arriving in the same 60s window reclaimed it too — both
           * proceeded, and whichever finished first removed the directory out from under
           * the other, whose _unlock then failed silently. Stamping the mtime narrows
           * that window from a minute to the gap between the stat and the utimes.
           *
           * Not airtight — two racers can still both pass the stat. Making it so needs
           * an atomic claim (rename onto the path), which is a bigger change than this
           * lock deserves: it serialises launches of ONE worktree, and the cost of
           * losing is a duplicate dev server, not corruption.
           */
          fs.utimesSync(lock, new Date(), new Date());
          return lock;
        }
      } catch {
        /* */
      }
      return null;
    }
  }
  // The same lock, for a caller that can afford to wait a moment for a launch to
  // finish rather than giving up the instant it is held. Null when the wait expired.
  async _lockWaiting(worktreePath: string, timeoutMs: number): Promise<string | null> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const lock = this._lock(worktreePath);
      if (lock || Date.now() >= until) return lock;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  _unlock(lock: string): void {
    try {
      fs.rmdirSync(lock);
    } catch {
      /* */
    }
  }

  // opts.env: per-call env merged over the base ENV (concurrency slot offsets).
  // opts.ports: derived (slot-offset) ports to pre-check/poll instead of sc.ports.
  async start(repo: string, worktreePath: string, opts: Partial<LaunchOpts> = {}): Promise<StartResult> {
    const sc = this.startCfg(repo);
    // `opts.cmd` is a run configuration standing in for the repo's start command, so a
    // repo with no `config.start` entry can still launch one.
    if (!sc && !opts.cmd) return { ok: false, error: `no start config for repo '${repo}'` };
    // The port flag rides on the END of the command, where a shell puts arguments —
    // `npm start` becomes `npm start -- --port 5273`. Appended here rather than baked
    // into config.start so the same entry works with concurrency off.
    const cmd = `${opts.cmd || sc!.cmd}${opts.portArgs ? ` ${opts.portArgs}` : ''}`;
    const env = opts.env && Object.keys(opts.env).length ? { ...ENV, ...opts.env } : ENV;
    const ports = opts.ports?.length ? opts.ports : (sc?.ports ?? []);
    // Waited for, briefly: the holder is usually a stop of this same worktree that is
    // about to finish, and refusing the launch the user pressed Start for because a
    // half-second-old Stop has not settled yet is a worse answer than waiting for it.
    const lock = await this._lockWaiting(worktreePath, LOCK_WAIT_MS);
    if (!lock)
      return { ok: false, error: `another start or stop for '${repo}' at ${worktreePath} is in progress` };
    // From here until the ports are up (or we give up waiting), this feature's slot
    // must survive a reconcile sweep — the ports it was allocated for are exactly
    // the ones not bound yet.
    const feature = this.featureFor(worktreePath);
    this._beginStart(feature);
    try {
      for (const p of ports) {
        const pid = await this.portPid(p);
        if (pid) return { ok: false, error: `port ${p} already in use (pid ${pid})` };
      }
      // Re-point the worktree's FE config at this slot's sibling port before spawning.
      if (opts.patch) this.applyConfigPatch(worktreePath, opts.patch);
      const log = path.join(this.logDir, `${repo}__${path.basename(worktreePath)}.log`);
      trimLog(log); // a relaunch must not inherit whatever the last run grew to
      const fd = fs.openSync(log, 'a');
      // Stamped either side of the spawn so the record can later be checked against
      // the process's real start time — that is what stops a recycled pid from
      // being signalled as though it were still this dev server.
      const startedAt = Date.now();
      let child: ChildProcess;
      try {
        fs.writeSync(fd, `\n===== ${new Date().toISOString()} :: ${cmd} @ ${worktreePath} =====\n`);
        child = spawn('bash', ['-lc', cmd], {
          cwd: worktreePath,
          detached: true,
          stdio: ['ignore', fd, fd],
          env,
        });
      } finally {
        // spawn() dups this descriptor into the child synchronously, so by the time
        // it returns the parent's copy is dead weight — and the daemon outlives every
        // dev server it launches. Leaving it open burned one descriptor per start()
        // (and two per restart(), which is a stop plus a start), stacking with
        // watch.ts's fs.watch handles and the terminal PTYs toward EMFILE. Past that
        // point arm() silently stops arming watchers and freshness quietly degrades
        // to the safety-net timer, with nothing anywhere saying why.
        fs.closeSync(fd);
      }
      child.unref();
      /*
       * A failed spawn is an EVENT, and an unhandled one killed the whole daemon.
       *
       * Node reports a spawn that never happened — a missing `bash`, and crucially a
       * `cwd` that no longer exists — asynchronously as an 'error' event rather than by
       * throwing. Unhandled, that becomes an uncaughtException, and crash.ts treats
       * anything outside the connection-error codes as fatal and exits. So pressing Run
       * on a feature whose worktree had been deleted behind Studio's back took down every
       * PTY, the SSE fan-out and the HTTP server with it — one request, total loss.
       *
       * This was the ONLY spawn site missing the guard: runner.ts, installDeps below and
       * hunks.ts all attach one. Exactly the drift this codebase keeps producing.
       *
       * setImmediate resolves the race the other way: 'error' fires on the next tick at
       * the latest, so if it has not fired by then the spawn succeeded.
       */
      const spawnError = await new Promise<Error | null>((resolve) => {
        child.once('error', resolve);
        setImmediate(() => resolve(null));
      });
      if (spawnError) {
        // Nothing was started, so nothing is tracked — `child.pid` is undefined for a
        // failed spawn, and persisting that junk record surfaced at the next boot as
        // "dropped stale tracked pid undefined".
        return { ok: false, error: `could not start ${repo}: ${spawnError.message}` };
      }
      this.tracked[worktreePath] = { pid: child.pid, repo, log, startedAt };
      this._save();
      /*
       * Poll for the ports to bind. The verdict is REPORTED now rather than discarded:
       * this loop always ran to completion and then returned `ok: true` either way, so
       * a dev server that spent the whole window failing to bind was indistinguishable
       * from one that came up in 500 ms.
       *
       * `undefined` when there are no ports to watch — see StartResult. That is not the
       * same as "it came up", and the caller has to be able to tell them apart.
       */
      let listening: boolean | undefined;
      if (ports.length) {
        for (let i = 0; i < 16; i++) {
          await new Promise((r) => setTimeout(r, 500));
          let allUp = true;
          for (const p of ports) if (!(await this.portPid(p))) allUp = false;
          if (allUp) {
            listening = true;
            break;
          }
          listening = false;
        }
      }
      // The expected ports never came up. Before calling that a dead server, ask whether
      // this worktree is listening on something else — see `boundElsewhere`. One full
      // lsof scan, on the failure path only, to turn "it didn't start" into "it started
      // on a port you weren't expecting".
      let boundElsewhere: number[] | undefined;
      if (listening === false) {
        try {
          const hit = (await this.discoverRunning()).get(realpath(worktreePath));
          const other = (hit?.ports || []).filter((p) => !ports.includes(p));
          if (other.length) boundElsewhere = other;
        } catch {
          /* diagnosis is a bonus; never let it change the launch outcome */
        }
      }
      return { ok: true, pid: child.pid, log, listening, boundElsewhere };
    } finally {
      this._endStart(feature);
      this._unlock(lock);
    }
  }

  /**
   * Allocate the slots, then launch — the whole sequence, once.
   *
   * Three routes spelled this out independently (`/sessions/:id/servers/start`,
   * `/servers/start`, `/group/start`): featureFor → allocSlotFor → 409 on error →
   * start(repo, path, launchOpts(repo, feature)). Three copies is how the stop
   * counterparts came to disagree about when a slot may be released, and it is how the
   * next divergence would have arrived too.
   *
   * ALL slots are allocated before ANY launch, deliberately. Allocating as you go means
   * a stack that runs out of slots half way has already spawned the first half, and the
   * caller's 409 then describes a state it has partly created.
   *
   * Launches run concurrently: start() takes a per-worktree lock, so distinct worktrees
   * never contend, and a multi-repo stack should not pay the sum of its members' boot
   * times. (The session route used to do this serially, for no stated reason.)
   */
  async startAll(
    targets: Array<{ repo: string; worktreePath: string }>,
  ): Promise<
    { ok: false; slotError: string } | { ok: true; results: Array<{ repo: string } & StartResult> }
  > {
    for (const t of targets) {
      const alloc = this.allocSlotFor(this.featureFor(t.worktreePath));
      if (alloc.error) return { ok: false, slotError: alloc.error };
    }
    const results = await Promise.all(
      targets.map(async (t) => {
        const feature = this.featureFor(t.worktreePath);
        return {
          repo: t.repo,
          ...(await this.start(t.repo, t.worktreePath, this.launchOpts(t.repo, feature))),
        };
      }),
    );
    return { ok: true, results };
  }

  /**
   * Stop every target, then free the slots the stop really emptied — the whole sequence,
   * once, as startAll is for launching.
   *
   * Five routes spelled this out independently, and the two halves that matter are the
   * ORDER and the GUARD. Release before the refresh and a member that refused to die
   * keeps its ports while its slot goes back in the pool; release unconditionally and a
   * feature member the caller never enumerated keeps running on ports the next feature is
   * about to be handed. Both mistakes shipped, in different routes, which is what a
   * sequence copied five times produces.
   *
   * `running` re-discovers and hands back what is still listening — a callback rather
   * than a map, because it must be read AFTER the stops (the guard is a question about
   * the post-stop world) and because the caller's own cache is what the rest of its
   * request reads. `settleMs` waits before asking: a SIGTERMed server can still hold its
   * socket for a moment, and a caller that is about to reuse those ports (the
   * stop-conflicts path) needs the answer to be settled rather than merely immediate.
   */
  async stopAll(
    targets: Array<{ repo: string; worktreePath: string; ports?: number[] }>,
    running: () => Promise<Map<string, RunningServer>>,
    settleMs = 0,
  ): Promise<Array<{ repo: string } & StopResult>> {
    // Concurrently, as startAll launches: stop() takes a per-worktree lock, so distinct
    // worktrees never contend, and a stack should not pay the sum of its members' settles.
    const results = await Promise.all(
      targets.map(async (t) => ({
        repo: t.repo,
        ...(await this.stop(t.repo, t.worktreePath, t.ports ?? [])),
      })),
    );
    if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
    const live = await running();
    for (const t of targets) this.releaseSlotIfIdle(this.featureFor(t.worktreePath), live);
    return results;
  }

  // Ports a server in this worktree would be listening on: the feature's
  // slot-derived ports when concurrency-slotted, else the repo's configured ports.
  /**
   * The ports this worktree would be using — or NOTHING, when that cannot be known.
   *
   * `launchOpts` resolves `slots.get(feature) ?? 0`, which conflates "this feature has no
   * slot" with "this feature is at slot 0". Harmless on the launch path, where startAll
   * allocates a slot before anything is spawned. Not harmless here: stop() feeds this
   * list into a port sweep that SIGTERMs whatever is listening, so a slot-less feature
   * derived slot 0's base ports and killed the dev servers of whichever OTHER feature
   * actually holds slot 0 — answering `killed: true` while stopping nothing of its own.
   *
   * When concurrency governs this repo and the feature holds no slot, the honest answer
   * is that it has no ports. An empty list stops nothing, which is correct: a feature
   * with no slot never started anything through a slot.
   */
  _portsFor(repo: string, worktreePath: string): number[] {
    const feature = this.featureFor(worktreePath);
    if (this._concEnabled() && this._repoConc(repo) && this.slots.get(feature) === undefined) {
      return [];
    }
    const opts = this.launchOpts(repo, feature);
    if (opts.ports?.length) return opts.ports;
    const sc = this.startCfg(repo);
    return sc ? sc.ports : [];
  }

  /**
   * Stop this worktree's dev server.
   *
   * `alsoPorts` is where the server has been OBSERVED listening, which is not always
   * where its slot says it should be. The sweep below derived its whole port list from
   * the slot, so a server that drifted onto another slot's ports — started outside
   * Studio, or by a start command that ignored the slot env — was unreachable by the
   * only thing that owns it. stop() probed the slot, found nothing, reported success,
   * and left the process holding ports that belong to a different feature: its API
   * answered that feature's frontend from the wrong branch, and a restart produced two
   * servers for one worktree rather than replacing one.
   *
   * The caller supplies them because the caller already has them — `decorate()` reports
   * exactly this as `offSlot`, and the route handlers hold the running map it came
   * from. Passing them in keeps stop() targeted; discovering them here would mean a
   * full lsof scan on every stop, including the group verbs that call it in a loop.
   *
   * Ownership is still proven per port before anything is signalled: a caller's list
   * can be a scan old, and by now the port may belong to somebody else entirely.
   */
  async stop(repo: string, worktreePath: string, alsoPorts: number[] = []): Promise<StopResult> {
    /*
     * Under the same per-worktree lock start() takes.
     *
     * A stop is a long asynchronous act — a `ps`, an `lsof` per port, a 600 ms settle —
     * and it used to run entirely outside that lock. Press Stop and then Start: the stop
     * is still waiting on its settle while start() spawns a new dev server and writes its
     * record, and the stop then finishes by deleting that record. The new server is up
     * and untracked forever — logs() has nothing to read, nothing can signal its process
     * group, and the only way out is to find the pid by hand.
     *
     * Waited for rather than required. A stop the user asked for must not be refusable,
     * and start() holds this lock for as long as its port poll runs, which is longer than
     * an HTTP caller should wait. When the wait expires we proceed anyway — the record
     * check in `forget` below is what makes that case safe.
     */
    const lock = await this._lockWaiting(worktreePath, LOCK_WAIT_MS);
    try {
      let killed = false;
      const t = this.tracked[worktreePath];
      /*
       * Drop the tracked record — but only when it is still the record this stop was
       * deciding about, and only once the stop is proven. Two ways forgetting too eagerly
       * hurt, and the deletion used to be unconditional and to happen up here, before the
       * SIGKILL escalation had even run:
       *
       *   A start that raced this stop has written a NEW record for this worktree.
       *   Deleting it orphans a server that is live. `startedAt` is stamped fresh on every
       *   launch, so it is what tells the two records apart.
       *
       *   The stop did not work. A process that declined SIGTERM and survived SIGKILL is
       *   still holding this feature's ports, and a record that is gone cannot be used to
       *   kill it, or to show it. It becomes an invisible squatter on ports reconcileSlots
       *   will hand to the next feature. Keeping it leaves it killable and visible.
       */
      const forget = (stillListening: number[]): void => {
        if (stillListening.length) return;
        const now = this.tracked[worktreePath];
        if (!t || !now || now.pid !== t.pid || now.startedAt !== t.startedAt) return;
        delete this.tracked[worktreePath];
        this._save();
      };
      // Never signal a pid we cannot still prove is ours — see _trackedPidState.
      // `kill(-pid)` takes out a whole process group, so getting this wrong is not a
      // near miss.
      const state = t ? await this._trackedPidState(t, worktreePath) : 'gone';
      // A record with no pid can only be 'gone', so `t.pid` here is the pid that state
      // was decided on.
      if (state === 'ours' && t.pid) {
        try {
          process.kill(-t.pid, 'SIGTERM');
          killed = true;
        } catch {
          try {
            process.kill(t.pid, 'SIGTERM');
            killed = true;
          } catch {
            /* */
          }
        }
      } else if (state === 'stranger') {
        // Loud, because it means this record was about to be used to kill something
        // that has nothing to do with Studio. The port sweep below still frees
        // whatever is genuinely holding this worktree's ports.
        console.warn(
          `[wt-studio] refusing to signal pid ${t.pid} for ${worktreePath}: it is no longer the process Studio started (pid reused). Dropping the stale record.`,
        );
      }
      // Also free any listener still holding one of this worktree's ports — where the slot
      // says it should be, plus wherever it has actually been seen. A targeted per-port
      // lookup either way, not a full lsof-all-sockets discovery scan. Deduped: each entry
      // costs a lookup, and a drifted server is usually reported on some of its slot ports
      // as well as the strays.
      const sweep = [...new Set([...this._portsFor(repo, worktreePath), ...alsoPorts])];
      const mine = realpath(worktreePath);
      for (const p of sweep) {
        const pid = await this.portPid(p);
        if (!pid || (t && pid === t.pid)) continue;
        /*
         * Prove the listener is OURS before signalling it.
         *
         * The port list alone is not proof of ownership: two features run the same repo
         * from different worktrees, and a stale or mis-derived port (see _portsFor) points
         * straight at a sibling's dev server. `kill` here is not a near miss — it stops
         * work in progress in a feature the user did not touch, and reported `killed:true`
         * while doing it. Resolving the pid's own worktree is the only honest test.
         *
         * A pid we cannot resolve is left alone: not-in-a-git-worktree means it is not a
         * dev server Studio started, so it is somebody else's process.
         */
        const info = await this._resolvePid(String(pid));
        if (!info || realpath(info.top) !== mine) continue;
        try {
          process.kill(pid, 'SIGTERM');
          killed = true;
        } catch {
          /* already gone — the outcome we wanted either way */
        }
      }

      /*
       * Did it actually stop? SIGTERM is a REQUEST, and a process may decline it.
       *
       * The return type was literally `{ ok: true; killed: boolean }` — `ok` was a constant
       * and there was no failure channel at all, so a server with a `process.on('SIGTERM')`
       * handler that keeps listening was reported as stopped while `lsof` still showed the
       * port bound. Nothing escalated, and the group verbs discarded even `killed`.
       *
       * One re-check after a short settle, then SIGKILL what is left. A caller that asked
       * for a stop is entitled to know whether it happened.
       */
      if (!killed || !sweep.length) {
        forget([]);
        return { ok: true, killed, stillListening: [] };
      }

      await new Promise((r) => setTimeout(r, 600));
      const stubborn: number[] = [];
      // The same list the SIGTERM pass used: a drifted server that declines a polite stop
      // has to be escalated on the port it is actually holding, or `stillListening` says
      // nothing is left while the squatted port is still bound.
      for (const p of sweep) {
        const pid = await this.portPid(p);
        if (!pid) continue;
        /*
         * Re-prove ownership before the SIGKILL, exactly as the SIGTERM pass does.
         *
         * Six hundred milliseconds ago this port belonged to our server. It may have died
         * in the meantime and something else may have taken the port — which is precisely
         * what happens when a neighbouring feature is starting up into the slot this
         * server was squatting. SIGKILL is not survivable and not a request.
         */
        const info = await this._resolvePid(String(pid));
        if (!info || realpath(info.top) !== mine) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone between the check and the signal, which is the outcome we wanted */
        }
        stubborn.push(p);
      }
      forget(stubborn);
      // Reported whether or not the SIGKILL landed: the caller wanted to know that a polite
      // stop was not enough, and a port that needed killing twice is worth surfacing.
      return { ok: true, killed, stillListening: stubborn };
    } finally {
      if (lock) this._unlock(lock);
    }
  }

  /**
   * `alsoPorts` for the same reason stop() takes it, and this is where its absence hurt
   * most: a restart whose stop cannot reach the old server does not replace it, it adds
   * a second one. The new process takes the slot's ports, the old one keeps the ports it
   * drifted onto, and both answer.
   */
  async restart(
    repo: string,
    worktreePath: string,
    opts: Partial<LaunchOpts> = {},
    alsoPorts: number[] = [],
  ): Promise<StartResult> {
    // A restart is a window with nothing listening by design — the stop, the 800 ms
    // settle, and then start()'s own poll. The guard has to span the whole thing or
    // a sweep landing in the gap reclaims the slot the restart intends to reuse.
    // The nested _beginStart inside start() is why the counter is a count.
    const feature = this.featureFor(worktreePath);
    this._beginStart(feature);
    try {
      await this.stop(repo, worktreePath, alsoPorts);
      await new Promise((r) => setTimeout(r, 800));
      return await this.start(repo, worktreePath, opts);
    } finally {
      this._endStart(feature);
    }
  }

  // Bring every tracked log back under the size ceiling. One stat per tracked
  // worktree, so it is cheap enough to hang off the periodic sweep — which is the
  // only thing that bounds a dev server that has been running for days without a
  // restart. Returns how many were trimmed.
  trimLogs(): number {
    let trimmed = 0;
    for (const t of Object.values(this.tracked)) if (t?.log && trimLog(t.log)) trimmed++;
    return trimmed;
  }

  // Incremental log tail, guarded to tracked log files only.
  //  - opts.offset omitted → return the tail (last `lines` lines) + current byte size as the next offset.
  //  - opts.offset a number → return only the bytes written after that offset.
  // Always returns { offset, text, size, skipped } where `offset` is the byte position
  // to pass next and `skipped` is how many bytes the read cap dropped (0 normally).
  logs(worktreePath: string, opts: LogsOptions = {}): LogTail {
    // The shared tailer — Runner.logs() said it followed "the same contract as
    // Servers.logs" while implementing rotation, UTF-8 and `skipped` differently. Now it
    // is the same code rather than the same claim.
    return tailFile(this.tracked[worktreePath]?.log, opts);
  }
}

const LOG_LIMITS = { MAX_LOG_BYTES, KEEP_LOG_BYTES, TAIL_MAX_BYTES };

export { Servers, realpath, featureFromPath, trimLog, readTail, LOG_LIMITS };
