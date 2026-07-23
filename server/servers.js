'use strict';
// Dev-server control per worktree. Running state is DISCOVERED by mapping every
// listening socket to the process's cwd → git worktree top-level (like
// worktree-dash's core.sh), so it detects any server in any worktree — not only
// ones on a configured port. Configured `start[repo]` is used only to launch.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run, readJson, writeJson } = require('./util');

const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
const EPHEMERAL = 49152; // ports at/above this are ephemeral — ignore

function realpath(p) { try { return fs.realpathSync(p); } catch { return p; } }

class Servers {
  constructor(cfg) {
    this.cfg = cfg;
    this.selfPort = (cfg.web && cfg.web.port) || 0;
    this.logDir = path.join(cfg._stateDir, 'logs');
    this.lockDir = path.join(cfg._stateDir, 'locks');
    this.file = path.join(cfg._stateDir, 'servers.json');
    fs.mkdirSync(this.logDir, { recursive: true });
    fs.mkdirSync(this.lockDir, { recursive: true });
    this.tracked = readJson(this.file, {}); // worktreePath → { pid, repo, log }
  }

  _save() { writeJson(this.file, this.tracked); }

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

  _lock(repo) {
    const lock = path.join(this.lockDir, `${repo}.lock`);
    try { fs.mkdirSync(lock); return lock; }
    catch {
      // stale lock (>60s) → reclaim
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) { return lock; } } catch { /* */ }
      return null;
    }
  }
  _unlock(lock) { try { fs.rmdirSync(lock); } catch { /* */ } }

  async start(repo, worktreePath) {
    const sc = this.startCfg(repo);
    if (!sc) return { ok: false, error: `no start config for repo '${repo}'` };
    const lock = this._lock(repo);
    if (!lock) return { ok: false, error: `another launch for '${repo}' is in progress` };
    try {
      for (const p of sc.ports) {
        const pid = await this.portPid(p);
        if (pid) return { ok: false, error: `port ${p} already in use (pid ${pid})` };
      }
      const log = path.join(this.logDir, `${repo}__${path.basename(worktreePath)}.log`);
      const fd = fs.openSync(log, 'a');
      fs.writeSync(fd, `\n===== ${new Date().toISOString()} :: ${sc.cmd} @ ${worktreePath} =====\n`);
      const child = spawn('bash', ['-lc', sc.cmd], { cwd: worktreePath, detached: true, stdio: ['ignore', fd, fd], env: ENV });
      child.unref();
      this.tracked[worktreePath] = { pid: child.pid, repo, log };
      this._save();
      // poll for ports to bind (best-effort)
      for (let i = 0; i < 16 && sc.ports.length; i++) {
        await new Promise((r) => setTimeout(r, 500));
        let allUp = true;
        for (const p of sc.ports) if (!(await this.portPid(p))) allUp = false;
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

  async restart(repo, worktreePath) {
    await this.stop(repo, worktreePath);
    await new Promise((r) => setTimeout(r, 800));
    return this.start(repo, worktreePath);
  }

  logs(worktreePath, lines = 300) {
    const t = this.tracked[worktreePath];
    const log = t && t.log;
    if (!log || !fs.existsSync(log)) return '';
    return fs.readFileSync(log, 'utf8').split('\n').slice(-lines).join('\n');
  }
}

module.exports = { Servers, realpath };
