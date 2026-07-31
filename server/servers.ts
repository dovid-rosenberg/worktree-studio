// Dev-server control per worktree. Running state is DISCOVERED by mapping every
// listening socket to the process's cwd → git worktree top-level (like
// worktree-dash's core.sh), so it detects any server in any worktree — not only
// ones on a configured port. Configured `start[repo]` is used only to launch.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { run, readJsonState, writeJson, realpath, slug } from './util.ts';
import { deriveEnv, allocSlot, rewriteAllSiblingPorts } from './concurrency.ts';
import { createIdentity } from './identity.ts';
import type { Identity } from './identity.ts';
import type { ConcurrencyConfig, Config, PartialDeep, RepoConcurrency, Worktree } from './types.ts';

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
  patch?: ConfigPatchPlan;
}

export type StartResult = { ok: false; error: string } | { ok: true; pid?: number; log: string };

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

const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
const EPHEMERAL = 49152; // ports at/above this are ephemeral — ignore

// How far a process's real start time may sit from the moment we recorded spawning
// it. `ps -o lstart=` has one-second resolution and we stamp the record either side
// of the spawn, so a few seconds of slack is required; a pid the OS handed to
// somebody else is off by hours, or by a reboot.
const PID_START_SKEW_MS = 10000;

// Feature identity of a worktree, from a path alone. Kept as a free function for
// the callers that have nothing but a path and no resolver to hand; it answers
// with the default (`basename` strategy, `.worktrees` layout) convention. A
// Servers instance uses ITS OWN configured resolver (`this.identity`) instead, so
// slot keys always match the grouping in server/features.ts.
const DEFAULT_IDENTITY = createIdentity({});
function featureFromPath(worktreePath: string): string { return DEFAULT_IDENTITY.ofPath(worktreePath); }

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
const TAIL_MAX_BYTES = 512 * 1024;

// Read a byte range [start, end) from a file as UTF-8 (used for incremental log tails).
function readRange(file: string, start: number, end: number): string {
  const len = end - start;
  if (len <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(len); const n = fs.readSync(fd, buf, 0, len, start); return buf.toString('utf8', 0, n); }
  finally { fs.closeSync(fd); }
}

// The last `lines` lines of a file, read backwards from the end and capped at
// `maxBytes` — never the whole file. A first line the window clipped is dropped
// rather than shown as a fragment, which also disposes of the half UTF-8 sequence
// an arbitrary byte offset can land in the middle of.
function readTail(file: string, lines: number, maxBytes = TAIL_MAX_BYTES): string {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return ''; }
  const start = Math.max(0, size - maxBytes);
  let text = readRange(file, start, size);
  if (start > 0) { const nl = text.indexOf('\n'); text = nl >= 0 ? text.slice(nl + 1) : ''; }
  return text.split('\n').slice(-lines).join('\n');
}

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
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size <= max) return false;
  let fd: number;
  try { fd = fs.openSync(file, 'r+'); } catch { return false; }
  try {
    const want = Math.min(keep, size); // a keep larger than the file would read from a negative offset
    const buf = Buffer.alloc(want);
    const n = fs.readSync(fd, buf, 0, want, size - want);
    const nl = buf.subarray(0, n).indexOf(0x0a); // resume on a line boundary
    const from = nl >= 0 && nl + 1 < n ? nl + 1 : 0;
    fs.writeSync(fd, buf, from, n - from, 0);
    fs.ftruncateSync(fd, n - from);
  } finally { fs.closeSync(fd); }
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
  _pidInfoCache: Map<string, PidInfo>;
  _starting: Map<string, number>;

  // `identity` is the shared server/identity.ts resolver (server.ts builds one and
  // hands the same instance to state.ts/orchestrator.ts). Passing it is what makes
  // "which feature is this worktree?" one answer instead of two.
  constructor(cfg: ServersConfig, identity?: Identity | null) {
    this.cfg = cfg;
    this.identity = identity || createIdentity(cfg);
    this.selfPort = (cfg.web && cfg.web.port) || 0;
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
    // pid (string) → { cwd, top } — a process's cwd/git-toplevel never change, so we
    // resolve each listening pid once and reuse it across discoverRunning scans.
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

  _save(): void { writeJson(this.file, { tracked: this.tracked, slots: Object.fromEntries(this.slots) }); }

  // The feature a worktree path belongs to, under the configured identity
  // strategy. Every slot key in the app goes through here or through
  // `identity.of()` on the equivalent worktree object — the two agree by
  // construction (server/identity.ts).
  featureFor(worktreePath: string): string { return this.identity.ofPath(worktreePath); }

  // ---- concurrency: per-feature slot allocation + derived launch env ----
  _concEnabled(): boolean { return !!(this.cfg.concurrency && this.cfg.concurrency.enabled); }
  _repoConc(repo: string): RepoConcurrency | null { const c = this.cfg.concurrency; return (c && c.repos && c.repos[repo]) || null; }
  // A repo that gets a concurrency slot runs on its own (offset) ports per feature,
  // so running it in two worktrees at once does NOT collide.
  isSlotted(repo: string): boolean { return this._concEnabled() && !!this._repoConc(repo); }

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

  releaseSlot(feature: string): void { if (feature && this.slots.delete(feature)) this._save(); }

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
  isStarting(feature: string): boolean { return this._starting.has(feature); }

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
  // When the repo declares a `configPatch` (e.g. an FE that hardcodes accept-blue's
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
    const cp = rc.configPatch;
    if (cp) {
      const sib = this._repoConc(cp.siblingRepo);
      const siblingPortEnv = sib && sib.portEnv;
      if (siblingPortEnv) return { env, ports, patch: { file: cp.file, siblingPortEnv, slot } };
    }
    return { env, ports };
  }

  // Rewrite a worktree's gitignored FE config to point at this slot's sibling ports.
  // Shifts every one of the sibling repo's port families (su/merchant/iso/…) uniformly.
  // Best-effort + file-exists guarded: silently no-op when the file isn't present.
  applyConfigPatch(worktreePath: string, patch?: ConfigPatchPlan | null): void {
    if (!patch || !patch.file) return;
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
    } catch { /* best-effort — never block a launch on a config rewrite */ }
  }

  startCfg(repo: string): StartCommand | null {
    const s = this.cfg.start && Object.prototype.hasOwnProperty.call(this.cfg.start, repo) ? this.cfg.start[repo] : null;
    if (!s) return null;
    if (typeof s === 'string') return { cmd: s, ports: [] };
    // An entry with no `cmd` is not a launchable config: canStart would advertise one
    // and start() would then hand `undefined` to spawn(). POST /settings drops such
    // rows, but a hand-edited config.json can still carry one.
    if (!s.cmd) return null;
    return { cmd: s.cmd, ports: s.ports || [] };
  }

  alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

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
  async _trackedPidState(t?: TrackedServer | null): Promise<TrackedPidState> {
    if (!t || !t.pid) return 'gone';
    const info = await this._psInfo(t.pid);
    if (!info) return 'gone';
    if (t.startedAt) return Math.abs(info.startedAt - t.startedAt) <= PID_START_SKEW_MS ? 'ours' : 'stranger';
    // Records written before `startedAt` existed — servers.json outlives upgrades.
    // Fall back to the command we would have launched for that repo: weaker than a
    // start time, but it still tells a dev server from someone else's daemon, and
    // it is strictly better than trusting the bare number.
    const sc = t.repo ? this.startCfg(t.repo) : null; // a record with no repo has no command to match either
    return sc && sc.cmd && info.command.includes(sc.cmd) ? 'ours' : 'stranger';
  }

  // Drop every tracked record that no longer names a process we launched. Called at
  // boot, which is where the damage was: the map accumulated across restarts and
  // reboots, so entries written days ago were still live kill targets.
  async pruneTracked(): Promise<DroppedRecord[]> {
    const dropped: DroppedRecord[] = [];
    for (const [wt, t] of Object.entries(this.tracked)) {
      if (await this._trackedPidState(t) === 'ours') continue;
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
      if (line[0] === 'p') { pid = line.slice(1); if (!byPid.has(pid)) byPid.set(pid, new Set()); }
      else if (line[0] === 'n' && pid) {
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
      let info: PidInfo | null | undefined = this._pidInfoCache.get(p);
      if (!info) {
        info = await this._resolvePid(p);
        if (!info) continue; // not in a git worktree — retry next scan (don't cache misses)
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
    if (!fs.existsSync(path.join(worktreePath, 'package.json'))) return { ok: false, error: 'no package.json here' };
    if (this.installing.has(worktreePath)) return { ok: false, error: 'already installing' };

    this.installing.add(worktreePath);
    const log = path.join(this.logDir, `install__${path.basename(worktreePath)}.log`);
    try {
      trimLog(log);
      const fd = fs.openSync(log, 'a');
      let child: ChildProcess;
      try {
        fs.writeSync(fd, `\n===== ${new Date().toISOString()} :: npm install @ ${worktreePath} =====\n`);
        child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
          cwd: worktreePath, stdio: ['ignore', fd, fd], env: ENV,
        });
      } finally { fs.closeSync(fd); }

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
      if (!fs.existsSync(path.join(worktreePath, 'package.json'))) return false;
      return !fs.existsSync(path.join(worktreePath, 'node_modules'));
    } catch { return false; }
  }

  // Attach running/pid/ports/canStart to a worktree object using a discovered map.
  decorate(worktree: Pick<Worktree, 'path' | 'repo'>, running: Map<string, RunningServer>): Pick<Worktree, 'running' | 'pid' | 'ports' | 'canStart' | 'depsMissing' | 'depsInstalling'> {
    const hit = running.get(realpath(worktree.path));
    const deps = this.depsMissing(worktree.path);
    return {
      running: !!hit,
      pid: hit ? hit.pid : null,
      ports: hit ? hit.ports : [],
      // `canStart` used to mean "a start command is configured", so it stayed true for a
      // worktree that could not possibly start. Every caller reads it as "starting this
      // will work" — /group/start filters `toStart` on it — so it now means that.
      canStart: !!this.startCfg(worktree.repo) && !deps,
      depsMissing: deps,
      depsInstalling: this.installing.has(worktree.path),
    };
  }

  // Serialize concurrent launches of the SAME worktree (not the same repo — two
  // worktrees of one repo must start concurrently). Lock name is a filesystem-safe
  // slug + hash of the worktree path so distinct paths never share a lock.
  _lock(worktreePath: string): string | null {
    const name = `${slug(worktreePath, 40)}-${crypto.createHash('sha1').update(String(worktreePath)).digest('hex').slice(0, 8)}`;
    const lock = path.join(this.lockDir, `${name}.lock`);
    try { fs.mkdirSync(lock); return lock; }
    catch {
      // stale lock (>60s) → reclaim
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) { return lock; } } catch { /* */ }
      return null;
    }
  }
  _unlock(lock: string): void { try { fs.rmdirSync(lock); } catch { /* */ } }

  // opts.env: per-call env merged over the base ENV (concurrency slot offsets).
  // opts.ports: derived (slot-offset) ports to pre-check/poll instead of sc.ports.
  async start(repo: string, worktreePath: string, opts: Partial<LaunchOpts> = {}): Promise<StartResult> {
    const sc = this.startCfg(repo);
    if (!sc) return { ok: false, error: `no start config for repo '${repo}'` };
    const env = opts.env && Object.keys(opts.env).length ? { ...ENV, ...opts.env } : ENV;
    const ports = opts.ports && opts.ports.length ? opts.ports : sc.ports;
    const lock = this._lock(worktreePath);
    if (!lock) return { ok: false, error: `another launch for '${repo}' at ${worktreePath} is in progress` };
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
        fs.writeSync(fd, `\n===== ${new Date().toISOString()} :: ${sc.cmd} @ ${worktreePath} =====\n`);
        child = spawn('bash', ['-lc', sc.cmd], { cwd: worktreePath, detached: true, stdio: ['ignore', fd, fd], env });
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
      this.tracked[worktreePath] = { pid: child.pid, repo, log, startedAt };
      this._save();
      // poll for ports to bind (best-effort)
      for (let i = 0; i < 16 && ports.length; i++) {
        await new Promise((r) => setTimeout(r, 500));
        let allUp = true;
        for (const p of ports) if (!(await this.portPid(p))) allUp = false;
        if (allUp) break;
      }
      return { ok: true, pid: child.pid, log };
    } finally { this._endStart(feature); this._unlock(lock); }
  }

  // Ports a server in this worktree would be listening on: the feature's
  // slot-derived ports when concurrency-slotted, else the repo's configured ports.
  _portsFor(repo: string, worktreePath: string): number[] {
    const opts = this.launchOpts(repo, this.featureFor(worktreePath));
    if (opts.ports && opts.ports.length) return opts.ports;
    const sc = this.startCfg(repo);
    return sc ? sc.ports : [];
  }

  async stop(repo: string, worktreePath: string): Promise<{ ok: true; killed: boolean }> {
    let killed = false;
    const t = this.tracked[worktreePath];
    // Never signal a pid we cannot still prove is ours — see _trackedPidState.
    // `kill(-pid)` takes out a whole process group, so getting this wrong is not a
    // near miss.
    const state = t ? await this._trackedPidState(t) : 'gone';
    // A record with no pid can only be 'gone', so `t.pid` here is the pid that state
    // was decided on.
    if (state === 'ours' && t.pid) {
      try { process.kill(-t.pid, 'SIGTERM'); killed = true; } catch { try { process.kill(t.pid, 'SIGTERM'); killed = true; } catch { /* */ } }
    } else if (state === 'stranger') {
      // Loud, because it means this record was about to be used to kill something
      // that has nothing to do with Studio. The port sweep below still frees
      // whatever is genuinely holding this worktree's ports.
      console.warn(`[wt-studio] refusing to signal pid ${t.pid} for ${worktreePath}: it is no longer the process Studio started (pid reused). Dropping the stale record.`);
    }
    // Also free any listener still holding one of this worktree's known ports —
    // a targeted per-port lookup rather than a full lsof-all-sockets discovery scan.
    for (const p of this._portsFor(repo, worktreePath)) {
      const pid = await this.portPid(p);
      if (pid && (!t || pid !== t.pid)) { try { process.kill(pid, 'SIGTERM'); killed = true; } catch { /* */ } }
    }
    delete this.tracked[worktreePath];
    this._save();
    return { ok: true, killed };
  }

  async restart(repo: string, worktreePath: string, opts: Partial<LaunchOpts> = {}): Promise<StartResult> {
    // A restart is a window with nothing listening by design — the stop, the 800 ms
    // settle, and then start()'s own poll. The guard has to span the whole thing or
    // a sweep landing in the gap reclaims the slot the restart intends to reuse.
    // The nested _beginStart inside start() is why the counter is a count.
    const feature = this.featureFor(worktreePath);
    this._beginStart(feature);
    try {
      await this.stop(repo, worktreePath);
      await new Promise((r) => setTimeout(r, 800));
      return await this.start(repo, worktreePath, opts);
    } finally { this._endStart(feature); }
  }

  // Bring every tracked log back under the size ceiling. One stat per tracked
  // worktree, so it is cheap enough to hang off the periodic sweep — which is the
  // only thing that bounds a dev server that has been running for days without a
  // restart. Returns how many were trimmed.
  trimLogs(): number {
    let trimmed = 0;
    for (const t of Object.values(this.tracked)) if (t && t.log && trimLog(t.log)) trimmed++;
    return trimmed;
  }

  // Incremental log tail, guarded to tracked log files only.
  //  - opts.offset omitted → return the tail (last `lines` lines) + current byte size as the next offset.
  //  - opts.offset a number → return only the bytes written after that offset.
  // Always returns { offset, text, size, skipped } where `offset` is the byte position
  // to pass next and `skipped` is how many bytes the read cap dropped (0 normally).
  logs(worktreePath: string, opts: LogsOptions = {}): LogTail {
    // Captured rather than re-read: "this call is incremental" and "the offset it is
    // incremental from" are one fact, and null is the form that carries both.
    const offset = typeof opts.offset === 'number' && Number.isFinite(opts.offset) ? opts.offset : null;
    const t = this.tracked[worktreePath];
    const log = t && t.log;
    const empty = { offset: offset ?? 0, text: '', size: 0, skipped: 0 };
    if (!log || !fs.existsSync(log)) return empty;
    let size: number;
    try { size = fs.statSync(log).size; } catch { return empty; }
    if (offset !== null) {
      // a shrunken file means it was truncated/rotated — re-read from the start
      const start = offset > size ? 0 : Math.max(0, offset);
      // A client that has been away — or a server that dumped a burst — must not be
      // able to make us allocate the whole gap in one Buffer. Skip forward to the
      // last TAIL_MAX_BYTES and report what that cost.
      const from = Math.max(start, size - TAIL_MAX_BYTES);
      return { offset: size, text: readRange(log, from, size), size, skipped: from - start };
    }
    return { offset: size, text: readTail(log, opts.lines || 300), size, skipped: 0 };
  }
}

const LOG_LIMITS = { MAX_LOG_BYTES, KEEP_LOG_BYTES, TAIL_MAX_BYTES };

export { Servers, realpath, featureFromPath, trimLog, readTail, LOG_LIMITS };
