'use strict';
// Feature identity — "which worktrees are the same feature?".
//
// A feature is a unit of work that owns one worktree in each of several repos.
// Studio has always answered the question with one convention: worktrees are the
// same feature when their directory basename matches byte-for-byte. That single
// convention is load-bearing — Fleet grouping, concurrency slots, multi-repo
// sessions, the SwiftBar menubar and `wt-studio add-repo` all key off it — so it
// gets a strategy here rather than staying a `w.wtname` reference in two files.
//
// Two callers derive identity, and they MUST agree or a feature grouped one way
// and slotted another would collide on ports:
//   - features.js computeFeatures() groups worktree OBJECTS (it has repo/branch/wtname)
//   - servers.js/orchestrator.js key a concurrency slot from a PATH alone
// Both go through one resolver here. `of(worktree)` is the real implementation;
// `ofPath(path)` looks the path up in an index fed from the repo scan and calls
// `of` with the worktree it found — so the path form is the object form, not a
// parallel derivation that can drift. On an index miss (a path the scan doesn't
// know yet) it degrades to the layout name, which is what the old
// featureFromPath() returned for every path.
//
// Strategies:
//   basename  the worktree's directory name (default; today's behavior exactly)
//   branch    a capture group of a regex applied to the branch name, so
//             `fix/123-payment` and `feat/123-ui` both yield `123` and group
//   manifest  explicit mapping, read from the EXISTING config.groups manual groups
//             (see the note on MANIFEST below — this is not a second config surface)
const path = require('path');
const layoutMod = require('./layout');
const { createRealpathCache } = require('./util');

const STRATEGIES = ['basename', 'branch', 'manifest'];

// Compile the `branch` strategy's regex. Returns { re } or { error } — never
// throws, because an invalid regex in a hand-edited config must not stop the
// server booting. Callers that get `{ error }` fall back to `basename`.
function compileBranchMatcher(pattern, flags) {
  if (!pattern) return { error: 'featureIdentity.branchPattern is empty' };
  // `g`/`y` make exec() stateful via lastIndex — the same branch would match on
  // one call and miss on the next. Strip them; identity only ever wants the first match.
  const safe = String(flags || '').replace(/[gy]/g, '');
  let re;
  try { re = new RegExp(String(pattern), safe); }
  catch (e) { return { error: e.message }; }
  // A pattern with no capture group can only ever match, never extract, so it
  // would silently behave as `basename` for every worktree. Say so at load time.
  // `source + '|'` makes the pattern match the empty string without changing how
  // many groups it has, so the exec result's length counts them exactly — no
  // guessing at parentheses inside character classes or escapes.
  let groups = 0;
  try { groups = new RegExp(`${re.source}|`).exec('').length - 1; } catch { groups = 1; }
  if (groups === 0) return { error: 'featureIdentity.branchPattern has no capture group' };
  return { re };
}

// The first group that actually captured. A pattern with several groups
// (`^(?:fix|feat)/(\d+)-(.*)$`) is ambiguous, so the rule is stated rather than
// left to chance: the leftmost group that matched wins, and any later ones are
// ignored. `(?:…)` non-capturing groups are invisible here, which is the escape
// hatch for a pattern that needs grouping without claiming the identity.
function firstCapture(m) {
  if (!m) return null;
  for (let i = 1; i < m.length; i++) if (m[i] !== undefined && m[i] !== '') return m[i];
  return null;
}

// MANIFEST: config.groups is already an explicit "these worktrees are one
// feature" mapping ([{ name, members: ["repo/branch-or-wtname"] }]). A separate
// manifest config key would be the same data written twice, so `manifest` reads
// config.groups instead of inventing one. What it adds is reach: manual groups
// only ever shaped the Fleet grouping, and slot keying kept using the basename —
// so a manual group whose members are named differently per repo got a slot each
// and its repos collided on ports. Under `manifest` the group name becomes the
// feature identity everywhere, grouping and slotting alike.
function manifestIndex(groups) {
  const byRef = new Map();
  for (const g of groups || []) {
    if (!g || !g.name) continue;
    for (const ref of g.members || []) {
      if (typeof ref === 'string') byRef.set(ref, g.name);
    }
  }
  return byRef;
}

/**
 * Build the resolver for a config. Pure apart from the console.warn on a bad
 * config and the realpath calls behind the path index.
 * @returns {{ strategy, layout, of, ofPath, nameOf, reindex, warning }}
 */
function createIdentity(cfg = {}) {
  const layout = layoutMod.resolve(cfg);
  const fi = cfg.featureIdentity || {};
  let strategy = String(fi.strategy || 'basename');
  let warning = null;

  if (!STRATEGIES.includes(strategy)) {
    warning = `featureIdentity.strategy '${strategy}' is not one of ${STRATEGIES.join('/')}`;
    strategy = 'basename';
  }

  let re = null;
  if (strategy === 'branch') {
    const c = compileBranchMatcher(fi.branchPattern, fi.branchFlags);
    if (c.error) {
      // Fall back rather than fail: a broken pattern degrades to the default
      // grouping, which is always safe, instead of taking the server down.
      warning = `featureIdentity: ${c.error} — falling back to the 'basename' strategy`;
      strategy = 'basename';
    } else {
      re = c.re;
    }
  }
  if (warning) console.warn(`[wt-studio] ${warning}.`);

  // Built lazily and re-built whenever cfg.groups is REPLACED. POST /settings
  // assigns a fresh array, so comparing identity is enough to notice an edit —
  // and it costs one reference check per lookup rather than a rebuild.
  // The sentinel is a fresh object rather than undefined/null, so an absent
  // cfg.groups still counts as "not built yet" on the first call.
  const UNBUILT = {};
  let manifestCache = { src: UNBUILT, map: null };
  function manifestMap() {
    if (manifestCache.src !== cfg.groups) manifestCache = { src: cfg.groups, map: manifestIndex(cfg.groups) };
    return manifestCache.map;
  }

  // path → { repo, wtname, branch }, fed from the repo scan. Only built for the
  // strategies that need more than the path itself, so the default costs nothing.
  const index = new Map();
  // The shared memo (util.js), not a local Map. Its rules are exactly the ones this
  // index needs and the hand-rolled version got wrong: a FAILED resolution is never
  // cached, and entries are retained against the caller's live path list.
  // Caching the fallback was a real bug — a worktree indexed before its symlink
  // resolved kept the unresolved spelling for the life of the process, so the
  // lsof-resolved path never matched and its dev server stopped being attributed to
  // the feature. See the regression tests in test/identity.test.js.
  const realpaths = createRealpathCache();
  const needsIndex = strategy !== 'basename';

  // The layout's name for a worktree: its own `wtname` when the caller has one
  // (the git scan's basename), else derived from the path. Having exactly one
  // function answer this for both callers is what keeps grouping and slotting
  // from drifting apart.
  function nameOf(w) {
    if (!w) return '';
    if (w.wtname) return w.wtname;
    if (w.name) return w.name;
    return layoutMod.nameFromPath(layout, w.path);
  }

  function of(w) {
    if (!w) return '';
    if (strategy === 'branch' && w.branch) {
      const cap = firstCapture(re.exec(w.branch));
      if (cap) return cap;
      // no match → this worktree isn't part of the scheme; group it by name
    }
    if (strategy === 'manifest' && w.repo) {
      const m = manifestMap();
      const hit = m.get(`${w.repo}/${nameOf(w)}`) || (w.branch && m.get(`${w.repo}/${w.branch}`));
      if (hit) return hit;
    }
    return nameOf(w);
  }

  function ofPath(p) {
    if (!p) return '';
    if (needsIndex) {
      const hit = index.get(p) || index.get(realpaths.resolve(p));
      if (hit) return of(hit);
    }
    return layoutMod.nameFromPath(layout, p);
  }

  // Feed the index from a git scan (server/git.js `scan()` output: repos, each
  // with .name and .worktrees[{ path, name, branch }]). Called after every rescan
  // so a worktree created, renamed or removed since boot resolves correctly.
  // A no-op under `basename`, which never consults the index.
  function reindex(repos) {
    if (!needsIndex) return;
    index.clear();
    const live = new Set();
    for (const repo of repos || []) {
      for (const w of repo.worktrees || []) {
        const entry = { repo: repo.name, wtname: w.wtname || w.name || path.basename(w.path), branch: w.branch, path: w.path };
        index.set(w.path, entry);
        live.add(w.path);
        // lsof hands us a resolved path while the scan hands us the spelling on
        // disk, so index both or a symlinked checkout never matches.
        const rp = realpaths.resolve(w.path);
        if (rp !== w.path) index.set(rp, entry);
      }
    }
    realpaths.retain(live);
  }

  return { strategy, layout, of, ofPath, nameOf, reindex, warning };
}

module.exports = { createIdentity, compileBranchMatcher, firstCapture, STRATEGIES };
