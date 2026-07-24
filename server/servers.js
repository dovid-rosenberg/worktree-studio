'use strict';
// Dev-server control per worktree. Running state is DISCOVERED by mapping every
// listening socket to the process's cwd → git worktree top-level (like
// worktree-dash's core.sh), so it detects any server in any worktree — not only
// ones on a configured port. Configured `start[repo]` is used only to launch.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { run, readJson, writeJson, slug } = require('./util');
const { deriveEnv, allocSlot, rewriteAllSiblingPorts } = require('./concurrency');

const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
const EPHEMERAL = 49152; // ports at/above this are ephemeral — ignore

function realpath(p) { try { return fs.realpathSync(p); } catch { return p; } }

// Feature identity of a worktree: its `.worktrees/<name>` basename (the name
// shared across repos). Main checkouts have no `.worktrees` segment → basename.
function featureFromPath(worktreePath) {
  const parts = String(worktreePath || '').split(path.sep);
  const i = parts.lastIndexOf('.worktrees');
  return (i >= 0 && parts[i + 1]) ? parts[i + 1] : path.basename(worktreePath || '');
}

// Read a byte range [start, end) from a file as UTF-8 (used for incremental log tails).
function readRange(file, start, end) {
  const len = end - start;
  if (len <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(len); const n = fs.readSync(fd, buf, 0, len, start); return buf.toString('utf8', 0, n); }
  finally { fs.closeSync(fd); }
}

class Servers {
  constructor(cfg) {
    this.cfg = cfg;
    this.selfPort = (cfg.web && cfg.web.port) || 0;
    this.logDir = path.join(cfg._stateDir, 'logs');
    this.lockDir = path.join(cfg._stateDir, 'locks');
    this.file = path.join(cfg._stateDir, 'servers.json');
    fs.mkdirSync(this.logDir, { recursive: true });
    fs.mkdirSync(this.lockDir, { recursive: true });
    // servers.json shape: { tracked: { worktreePath → { pid, repo, log } }, slots: { feature → slot } }.
    // Back-compat: an old flat file (just the tracked object) still loads as `tracked`.
    const saved = readJson(this.file, {});
    this.tracked = saved.tracked || saved; // worktreePath → { pid, repo, log }
    // featureName → slot (concurrency: one slot per feature, shared by its repos). Persisted
    // so a Studio restart while features run doesn't re-slot a running feature to slot 0.
    this.slots = new Map(Object.entries(saved.slots || {}).map(([k, v]) => [k, Number(v)]));
  }

  _save() { writeJson(this.file, { tracked: this.tracked, slots: Object.fromEntries(this.slots) }); }

  // ---- concurrency: per-feature slot allocation + derived launch env ----
  _concEnabled() { return !!(this.cfg.concurrency && this.cfg.concurrency.enabled); }
  _repoConc(repo) { const c = this.cfg.concurrency; return (c && c.repos && c.repos[repo]) || null; }

  // Allocate (or reuse) the slot for a feature. Returns { slot } or { error } when
  // all slots are busy. Slot 0 semantics when concurrency is off / no feature name.
  allocSlotFor(feature) {
    if (!this._concEnabled() || !feature) return { slot: 0 };
    if (this.slots.has(feature)) return { slot: this.slots.get(feature) };
    const max = this.cfg.concurrency.maxSlots || 1;
    const slot = allocSlot(new Set(this.slots.values()), max);
    if (slot === null) return { error: `no free concurrency slot (max ${max} running)` };
    this.slots.set(feature, slot);
    this._save();
    return { slot };
  }

  releaseSlot(feature) { if (feature && this.slots.delete(feature)) this._save(); }

  // Self-heal the slot map against reality: drop any slot whose feature has no
  // running worktree in `runningMap` (Map(realpath → {pid,ports}) from discoverRunning).
  // Called on the periodic refresh so leaked/stale slots are released and a
  // restart-with-running-servers keeps only the slots that are actually live.
  reconcileSlots(runningMap) {
    let changed = false;
    for (const feature of [...this.slots.keys()]) {
      if (![...runningMap.keys()].some((p) => featureFromPath(p) === feature)) {
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
  launchOpts(repo, feature) {
    if (!this._concEnabled()) return { env: {}, ports: [] };
    const rc = this._repoConc(repo);
    if (!rc) return { env: {}, ports: [] };
    const step = this.cfg.concurrency.offsetStep;
    const slot = this.slots.has(feature) ? this.slots.get(feature) : 0;
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
  applyConfigPatch(worktreePath, patch) {
    if (!patch || !patch.file) return;
    try {
      const file = path.join(worktreePath, patch.file);
      if (!fs.existsSync(file)) return;
      const step = this.cfg.concurrency.offsetStep;
      const max = this.cfg.concurrency.maxSlots || 1;
      const text = fs.readFileSync(file, 'utf8');
      const out = rewriteAllSiblingPorts(text, patch.siblingPortEnv, step, max, patch.slot);
      if (out !== text) fs.writeFileSync(file, out);
    } catch { /* best-effort — never block a launch on a config rewrite */ }
  }

  startCfg(repo) {
    const s = this.cfg.start && this.cfg.start[repo];
    if (!s) return null;
    if (typeof s === 'string') return { cmd: s, ports: [] };
    return { cmd: s.cmd, ports: s.ports || [] };
  }

  alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

  async portPid(port) {
    const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { env: ENV });
    const pid = r.stdout.trim().split('\n').filter(Boolean)[0];
    return pid ? Number(pid) : null;
  }

  // Map every LISTEN socket → owning process cwd → git worktree top-level.
  // Returns Map(realpath(worktreeTopLevel) → { pid, ports:[int] }).
  async discoverRunning() {
    const out = new Map();
    const r = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { env: ENV });
    if (r.code !== 0 && !r.stdout) return out;
    // parse -F output: `p<pid>` starts a process block; `n<host>:<port>` are its sockets
    const byPid = new Map();
    let pid = null;
    for (const line of r.stdout.split('\n')) {
      if (line[0] === 'p') { pid = line.slice(1); if (!byPid.has(pid)) byPid.set(pid, new Set()); }
      else if (line[0] === 'n' && pid) {
        const m = line.slice(1).match(/:(\d+)$/);
        if (m) {
          const port = Number(m[1]);
          if (port < EPHEMERAL && port !== this.selfPort) byPid.get(pid).add(port);
        }
      }
    }
    for (const [p, ports] of byPid) {
      if (!ports.size) continue;
      // cwd of the process
      const c = await run('lsof', ['-p', p, '-a', '-d', 'cwd', '-Fn'], { env: ENV });
      const cwdLine = c.stdout.split('\n').find((l) => l[0] === 'n');
      if (!cwdLine) continue;
      const cwd = cwdLine.slice(1);
      const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { env: ENV });
      if (top.code !== 0) continue;
      const key = realpath(top.stdout.trim());
      const cur = out.get(key) || { pid: Number(p), ports: [] };
      cur.ports = [...new Set([...cur.ports, ...ports])].sort((a, b) => a - b);
      out.set(key, cur);
    }
    return out;
  }

  // Attach running/pid/ports/canStart to a worktree object using a discovered map.
  decorate(worktree, running) {
    const hit = running.get(realpath(worktree.path));
    return {
      running: !!hit,
      pid: hit ? hit.pid : null,
      ports: hit ? hit.ports : [],
      canStart: !!this.startCfg(worktree.repo),
    };
  }

  // Serialize concurrent launches of the SAME worktree (not the same repo — two
  // worktrees of one repo must start concurrently). Lock name is a filesystem-safe
  // slug + hash of the worktree path so distinct paths never share a lock.
  _lock(worktreePath) {
    const name = `${slug(worktreePath, 40)}-${crypto.createHash('sha1').update(String(worktreePath)).digest('hex').slice(0, 8)}`;
    const lock = path.join(this.lockDir, `${name}.lock`);
    try { fs.mkdirSync(lock); return lock; }
    catch {
      // stale lock (>60s) → reclaim
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) { return lock; } } catch { /* */ }
      return null;
    }
  }
  _unlock(lock) { try { fs.rmdirSync(lock); } catch { /* */ } }

  // opts.env: per-call env merged over the base ENV (concurrency slot offsets).
  // opts.ports: derived (slot-offset) ports to pre-check/poll instead of sc.ports.
  async start(repo, worktreePath, opts = {}) {
    const sc = this.startCfg(repo);
    if (!sc) return { ok: false, error: `no start config for repo '${repo}'` };
    const env = opts.env && Object.keys(opts.env).length ? { ...ENV, ...opts.env } : ENV;
    const ports = opts.ports && opts.ports.length ? opts.ports : sc.ports;
    const lock = this._lock(worktreePath);
    if (!lock) return { ok: false, error: `another launch for '${repo}' at ${worktreePath} is in progress` };
    try {
      for (const p of ports) {
        const pid = await this.portPid(p);
        if (pid) return { ok: false, error: `port ${p} already in use (pid ${pid})` };
      }
      // Re-point the worktree's FE config at this slot's sibling port before spawning.
      if (opts.patch) this.applyConfigPatch(worktreePath, opts.patch);
      const log = path.join(this.logDir, `${repo}__${path.basename(worktreePath)}.log`);
      const fd = fs.openSync(log, 'a');
      fs.writeSync(fd, `\n===== ${new Date().toISOString()} :: ${sc.cmd} @ ${worktreePath} =====\n`);
      const child = spawn('bash', ['-lc', sc.cmd], { cwd: worktreePath, detached: true, stdio: ['ignore', fd, fd], env });
      child.unref();
      this.tracked[worktreePath] = { pid: child.pid, repo, log };
      this._save();
      // poll for ports to bind (best-effort)
      for (let i = 0; i < 16 && ports.length; i++) {
        await new Promise((r) => setTimeout(r, 500));
        let allUp = true;
        for (const p of ports) if (!(await this.portPid(p))) allUp = false;
        if (allUp) break;
      }
      return { ok: true, pid: child.pid, log };
    } finally { this._unlock(lock); }
  }

  async stop(repo, worktreePath) {
    let killed = false;
    const t = this.tracked[worktreePath];
    if (t && this.alive(t.pid)) {
      try { process.kill(-t.pid, 'SIGTERM'); killed = true; } catch { try { process.kill(t.pid, 'SIGTERM'); killed = true; } catch { /* */ } }
    }
    // also free any port currently held by a server in this worktree
    const running = await this.discoverRunning();
    const hit = running.get(realpath(worktreePath));
    if (hit) { try { process.kill(hit.pid, 'SIGTERM'); killed = true; } catch { /* */ } }
    delete this.tracked[worktreePath];
    this._save();
    return { ok: true, killed };
  }

  async restart(repo, worktreePath, opts = {}) {
    await this.stop(repo, worktreePath);
    await new Promise((r) => setTimeout(r, 800));
    return this.start(repo, worktreePath, opts);
  }

  // Incremental log tail, guarded to tracked log files only.
  //  - opts.offset omitted → return the tail (last `lines` lines) + current byte size as the next offset.
  //  - opts.offset a number → return only the bytes written after that offset.
  // Always returns { offset, text, size } where `offset` is the byte position to pass next.
  logs(worktreePath, opts = {}) {
    const incremental = typeof opts.offset === 'number' && Number.isFinite(opts.offset);
    const t = this.tracked[worktreePath];
    const log = t && t.log;
    if (!log || !fs.existsSync(log)) return { offset: incremental ? opts.offset : 0, text: '', size: 0 };
    let size;
    try { size = fs.statSync(log).size; } catch { return { offset: incremental ? opts.offset : 0, text: '', size: 0 }; }
    if (incremental) {
      // a shrunken file means it was truncated/rotated — re-read from the start
      const start = opts.offset > size ? 0 : Math.max(0, opts.offset);
      return { offset: size, text: readRange(log, start, size), size };
    }
    const lines = opts.lines || 300;
    const text = fs.readFileSync(log, 'utf8').split('\n').slice(-lines).join('\n');
    return { offset: size, text, size };
  }
}

module.exports = { Servers, realpath, featureFromPath };
