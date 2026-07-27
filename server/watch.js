'use strict';
// Freshness without polling. Boot used to run three unconditional timers: a 15s
// git rescan (a synchronous readdir walk of every baseDir plus ~4 git spawns per
// repo), a 3s `lsof` sweep of every listening socket on the machine, and a 4s
// `tmux has-session` per live session. That is a permanent CPU floor that grows
// with the repo count and burns exactly as much while nobody is looking at the
// dashboard as while somebody is — the first thing you notice on battery.
//
// This module owns all of that instead, and server.js wires it in one line:
//   1. filesystem watches on the paths a repo scan actually derives from, so a
//      worktree add/remove or a commit lands in ~a quarter second rather than up
//      to 15s, at no steady-state cost;
//   2. slow safety-net timers, because fs.watch lies (see below) and because
//      there is no filesystem event for "a process started listening on a port";
//   3. viewer-aware pacing — the sweeps that genuinely cannot be event-driven run
//      at a human interval while an SSE client is attached and back off hard when
//      none is. Nothing is *removed*; the discovery properties are unchanged.
//
// Everything here is overridable via `cfg.watch` (see DEFAULTS) for a repo layout
// that turns out to be noisier or quieter than the ones this was tuned against.
//
// --- fs.watch reality check (all verified on macOS + Node 22) -----------------
// The shape of the code below is dictated by four things fs.watch actually does,
// none of which are the happy path:
//   * Watching a *file* is useless for git. git writes `HEAD` and every ref by
//     renaming a `.lock` file over the target, so a file watcher fires once for
//     that rename and is then permanently dead — it still points at the unlinked
//     inode and never reports another change. We only ever watch DIRECTORIES.
//   * `filename` can be null. When it is, we cannot filter, so we assume the
//     event matters rather than dropping it.
//   * A non-recursive watch on macOS still reports changes from deep inside the
//     tree, collapsed to the name of the top-level child containing them. A watch
//     on a baseDir therefore fires on every file save in every repo beneath it.
//     `matters()` exists to keep that from becoming a rescan storm.
//   * Deleting a watched directory emits no 'error' — the watcher just goes
//     silent. Dead watchers are pruned by re-syncing the watch set after each
//     scan, not by waiting for an error that never arrives.
//   * `{ recursive: true }` is a macOS/Windows feature that only reached Linux in
//     Node 20, so every recursive arm falls back to a flat one on throw.
const fs = require('fs');
const path = require('path');
const gitMod = require('./git');

const DEFAULTS = {
  tickMs: 2000, // scheduler heartbeat: decides what is due, spawns nothing itself
  debounceMs: 250, // how long a burst of fs events must be quiet before we scan
  maxDebounceMs: 2000, // …but a sustained stream still lands within this
  minRescanMs: 3000, // hard ceiling on how often watching alone can shell out to git
  netActiveMs: 60000, // safety-net rescan, dashboard open (was: the 15s primary timer)
  netIdleMs: 300000, // safety-net rescan, nobody looking
  runningActiveMs: 8000, // lsof sweep, dashboard open (was: 3s, unconditional)
  runningIdleMs: 120000, // lsof sweep, nobody looking
  reconcileActiveMs: 6000, // tmux liveness, dashboard open (was: 4s, unconditional)
  reconcileIdleMs: 120000, // tmux liveness, nobody looking
  maxWatchers: 512, // refuse to arm past this — a pathological baseDir must not eat the fd table
};

// Entries directly inside `.git` that a scan derives from. `refs` and `worktrees`
// are here for two reasons: macOS reports deep changes under them by this name,
// and their appearance is our cue to arm the dedicated watchers below.
// Deliberately absent: `index` (rewritten by every `git status` anyone runs),
// `objects`, `logs`, `FETCH_HEAD`, `COMMIT_EDITMSG` — none feed the scan.
const GIT_DIR_ENTRIES = new Set(['HEAD', 'packed-refs', 'refs', 'worktrees']);

// Files inside `.git/worktrees/<name>/` a scan reads: HEAD is the worktree's
// checked-out branch, gitdir is the pointer git drops when the worktree is
// removed or pruned. `index`/`ORIG_HEAD`/`logs` churn on every command run inside
// the worktree and mean nothing to us.
const WORKTREE_FILES = new Set(['HEAD', 'gitdir']);

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function unref(t) { if (t && typeof t.unref === 'function') t.unref(); return t; }

/**
 * Start watching. Returns a handle with { stop, stats, watched, poke }.
 * @param {object} deps
 * @param {object} deps.cfg            loaded config (baseDirs, scanDepth, optional .watch)
 * @param {Function} deps.rescan       re-read repos/worktrees into the state cache
 * @param {Function} [deps.refreshRunning] lsof sweep for dev servers
 * @param {Function} [deps.reconcile]  multiplexer liveness sweep
 * @param {Function} [deps.hasViewers] true while a dashboard is attached (defaults to
 *                                     true, i.e. always-active pacing, so a partial
 *                                     wiring degrades to the old behaviour, not to silence)
 * @param {object} [deps.intervals]    DEFAULTS overrides — used by the tests to run the
 *                                     same code paths on a millisecond timescale
 */
async function start(deps) {
  const cfg = deps.cfg || {};
  const o = { ...DEFAULTS, ...(cfg.watch || {}), ...(deps.intervals || {}) };
  const watching = typeof deps.hasViewers === 'function'
    ? () => { try { return !!deps.hasViewers(); } catch { return true; } }
    : () => true;

  // dir → { w, kind }. One entry per watched directory; never one per ref file.
  const watchers = new Map();
  let knownRepos = new Set();
  let knownDirs = new Set();
  // Directories a container watch reported that the following scan then ignored —
  // they get one rescan each and are never allowed to cost another (see containerMatters).
  const dismissed = new Set();
  let stopped = false;
  let warnedCap = false;
  let scans = 0;

  // ---- watch set ------------------------------------------------------------

  function disarm(dir) {
    const e = watchers.get(dir);
    if (!e) return;
    watchers.delete(dir);
    try { e.w.close(); } catch { /* already dead */ }
  }

  function arm(dir, kind, recursive) {
    if (stopped || watchers.has(dir)) return;
    if (watchers.size >= o.maxWatchers) {
      if (!warnedCap) { warnedCap = true; console.warn(`[wt-studio] watch: hit maxWatchers (${o.maxWatchers}); falling back to the safety-net timer for the rest`); }
      return;
    }
    let w;
    try {
      w = fs.watch(dir, { persistent: false, recursive: !!recursive });
    } catch (e) {
      // recursive watching is unavailable on older Linux/Node — a flat watch on the
      // same directory is strictly better than no watch at all.
      if (recursive) { arm(dir, kind, false); return; }
      return; // vanished, unreadable, or out of descriptors — the next sync retries
    }
    w.on('error', () => disarm(dir));
    w.on('change', (event, filename) => {
      if (matters(dir, kind, filename == null ? null : String(filename))) trigger();
    });
    watchers.set(dir, { w, kind });
  }

  // Recompute the desired watch set from the current tree and reconcile against it.
  // Called at start and after every scan, which is also what prunes watchers for
  // repos that have gone away (fs.watch stays silent on a deleted directory).
  function sync() {
    if (stopped) return;
    let tree;
    try { tree = gitMod.walkTree(cfg.baseDirs || [], cfg.scanDepth || 3); } catch { return; }
    knownDirs = new Set(tree.dirs);
    knownRepos = new Set(tree.repos);

    const want = new Map(); // dir → [kind, recursive]
    for (const d of tree.dirs) want.set(d, ['container', false]);
    for (const repo of tree.repos) {
      const g = path.join(repo, '.git');
      // In a linked worktree `.git` is a FILE pointing elsewhere; there is nothing
      // watchable there and its real gitdir belongs to the main checkout, which is
      // scanned in its own right. Leave those to the safety net.
      if (!isDir(g)) continue;
      want.set(g, ['gitdir', false]);
      want.set(path.join(g, 'refs'), ['refs', true]);
      want.set(path.join(g, 'worktrees'), ['worktrees', true]);
    }

    for (const dir of [...watchers.keys()]) {
      if (!want.has(dir) || !isDir(dir)) disarm(dir);
    }
    for (const [dir, [kind, recursive]] of want) arm(dir, kind, recursive);
    // Let a dismissed directory earn a fresh look if it is removed and re-created.
    for (const p of [...dismissed]) if (!isDir(p) || knownRepos.has(p) || knownDirs.has(p)) dismissed.delete(p);
  }

  // ---- event filtering ------------------------------------------------------

  // A container watch sees, thanks to macOS collapsing deep changes onto the
  // top-level child, an event for every file anyone saves anywhere beneath it. The
  // only thing that can change *at this level* is the set of repos, so an event is
  // interesting only when a child's repo-ness disagrees with what the last scan
  // recorded. Two stat calls, no git spawned, no rescan for ordinary churn.
  function containerMatters(dir, name) {
    if (name === 'node_modules' || name.startsWith('.')) return false; // findRepos skips these
    const p = path.join(dir, name);
    if (knownRepos.has(p)) return !fs.existsSync(path.join(p, '.git')); // repo gone / de-gitted
    if (knownDirs.has(p)) return !isDir(p); // known container removed
    if (!isDir(p)) return false; // a loose file at this level can never be a repo
    if (fs.existsSync(path.join(p, '.git'))) return true; // a repo appeared (clone, init, move)
    // A directory we have never scanned: worth exactly one look. If the scan that
    // follows still doesn't know about it, it is out of scanDepth or otherwise
    // uninteresting, and its churn must not buy another rescan every 3 seconds.
    if (dismissed.has(p)) return false;
    dismissed.add(p);
    return true;
  }

  function matters(dir, kind, name) {
    if (name === null) return true; // macOS can report a null filename — assume it counts
    if (name.endsWith('.lock')) return false; // git's write-then-rename temp; the real name follows
    if (kind === 'container') return containerMatters(dir, name);
    if (kind === 'gitdir') return GIT_DIR_ENTRIES.has(name) || name === '.git';
    if (kind === 'refs') {
      const top = name.split(path.sep)[0];
      return top === 'heads' || top === 'remotes'; // tags feed nothing the scan reads
    }
    if (kind === 'worktrees') {
      const segs = name.split(path.sep);
      return segs.length === 1 || WORKTREE_FILES.has(segs[segs.length - 1]);
    }
    return true;
  }

  // ---- debounced, non-overlapping rescan ------------------------------------

  let debounce = null;
  let burstAt = 0;
  let scanBusy = false;
  let scanQueued = false;
  let lastScanAt = 0;

  function trigger() {
    if (stopped) return;
    if (!burstAt) burstAt = Date.now();
    if (debounce) clearTimeout(debounce);
    // Wait for the burst to go quiet, but never longer than maxDebounceMs from its
    // first event (a sustained stream must still land) and never sooner than
    // minRescanMs after the last scan (git operations touch many watched files at
    // once; this bounds what a pathological one can cost us).
    const settle = Math.min(o.debounceMs, Math.max(0, o.maxDebounceMs - (Date.now() - burstAt)));
    const cooldown = o.minRescanMs - (Date.now() - lastScanAt);
    debounce = unref(setTimeout(fire, Math.max(0, settle, cooldown)));
  }

  function fire() {
    debounce = null;
    burstAt = 0;
    runScan();
  }

  // Exactly one scan in flight. Anything that arrives mid-scan collapses into a
  // single follow-up rather than queueing per event (mirrors server.js's own
  // `scanning` guard, but re-runs afterwards instead of dropping the request).
  async function runScan() {
    if (stopped) return;
    if (scanBusy) { scanQueued = true; return; }
    scanBusy = true;
    try {
      await deps.rescan();
    } catch { /* a failed scan must never take the watcher down with it */ } finally {
      lastScanAt = Date.now();
      scans += 1;
      // Any scan resets the safety net — the net exists to cover a *quiet* period,
      // not to fire 60s after boot when watching already refreshed us a second ago.
      const net = jobs.find((j) => j.name === 'net');
      if (net) net.last = lastScanAt;
      try { sync(); } catch { /* */ } // the repo set may have changed under us
      scanBusy = false;
    }
    if (scanQueued && !stopped) { scanQueued = false; trigger(); }
  }

  // ---- periodic jobs --------------------------------------------------------
  //
  // One heartbeat drives all three. Each job declares an interval for "someone is
  // looking" and one for "nobody is"; the tick itself spawns nothing, so the cost
  // of checking often is nil and a dashboard that opens after a long idle gets a
  // fresh sweep within one tick instead of waiting out the idle interval.
  const jobs = [
    { name: 'running', fn: deps.refreshRunning, active: o.runningActiveMs, idle: o.runningIdleMs },
    { name: 'reconcile', fn: deps.reconcile, active: o.reconcileActiveMs, idle: o.reconcileIdleMs },
    { name: 'net', fn: runScan, active: o.netActiveMs, idle: o.netIdleMs },
  ].filter((j) => typeof j.fn === 'function');
  for (const j of jobs) { j.last = 0; j.busy = false; j.runs = 0; }

  function runJob(j) {
    j.last = Date.now();
    j.busy = true;
    return Promise.resolve().then(j.fn).catch(() => {}).then(() => { j.busy = false; j.runs += 1; });
  }

  function tick() {
    if (stopped) return;
    const active = watching();
    const now = Date.now();
    for (const j of jobs) {
      if (j.busy) continue;
      if (now - j.last >= (active ? j.active : j.idle)) runJob(j);
    }
  }

  // ---- boot -----------------------------------------------------------------
  sync();
  await runScan(); // awaited: boot logs the repo count straight after this returns
  for (const j of jobs) {
    // Prime `running` exactly as boot used to (an awaited lsof sweep before listen).
    // `reconcile` is deliberately NOT run here: it flips sessions whose mux session
    // died to stopped, and manager.restore() runs after us — reconciling first would
    // deactivate sessions restore() was about to bring back.
    if (j.name === 'running') await runJob(j); else j.last = Date.now();
  }
  const timer = unref(setInterval(tick, o.tickMs));

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      debounce = null;
      for (const dir of [...watchers.keys()]) disarm(dir);
    },
    // Force a debounced rescan — for callers that know something changed but that
    // the filesystem cannot tell us about.
    poke: trigger,
    watched() { return [...watchers.keys()].sort(); },
    stats() {
      const out = { scans, watchers: watchers.size, repos: knownRepos.size };
      for (const j of jobs) out[j.name] = j.runs;
      return out;
    },
  };
}

module.exports = { start, DEFAULTS };
