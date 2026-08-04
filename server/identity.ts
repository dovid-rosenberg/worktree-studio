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
//   - features.ts computeFeatures() groups worktree OBJECTS (it has repo/branch/wtname)
//   - servers.ts/orchestrator.ts key a concurrency slot from a PATH alone
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
import path from 'path';
import * as layoutMod from './layout.ts';
import { createRealpathCache } from './util.ts';
import type { ResolvedLayout } from './layout.ts';
import type { Config, FeatureIdentityConfig, GroupConfig, PartialDeep } from './types.ts';

export type IdentityStrategy = FeatureIdentityConfig['strategy'];

/**
 * As much of a worktree as identity ever reads. The git scan's rows, a session's
 * stored repo entry and a hand-built `{ repo, wtname, branch, path }` all qualify —
 * which is the point: `of()` must answer the same for all three.
 */
export interface IdentityInput {
  repo?: string;
  wtname?: string;
  name?: string;
  branch?: string | null;
  path?: string;
}

/**
 * One row of the scan `reindex()` is fed. `RepoWorktree` (server/git.ts) and a
 * topology `Worktree` both satisfy it: the git scan spells the name `name` and a
 * topology row spells it `wtname`, and this has always accepted either.
 */
export interface IdentityScanWorktree {
  path: string;
  name?: string;
  wtname?: string;
  branch?: string | null;
}

/** A scanned repo, reduced to the two fields `reindex()` reads. */
export interface IdentityScanRepo {
  name: string;
  worktrees?: IdentityScanWorktree[] | null;
}

/** What `compileBranchMatcher` answers: the compiled regex, or why there isn't one. */
export type BranchMatcher = { re: RegExp; error?: undefined } | { re?: undefined; error: string };

/**
 * The resolver `createIdentity` returns. state.ts, servers.ts and sessions.ts all
 * hold one; this is the whole of what they may call.
 */
export interface Identity {
  /** the one in force, after any fallback */
  strategy: IdentityStrategy;
  layout: ResolvedLayout;
  /** identity of a worktree object */
  of(w?: IdentityInput | null): string;
  /** identity of a path */
  ofPath(p?: string | null): string;
  /** the layout's name for it */
  nameOf(w?: IdentityInput | null): string;
  /** feed the path index from a git scan */
  reindex(repos?: IdentityScanRepo[] | null): void;
  /** what was wrong with the config, if anything */
  warning: string | null;
}

const STRATEGIES: IdentityStrategy[] = ['basename', 'branch', 'manifest'];

// Compile the `branch` strategy's regex. Returns { re } or { error } — never
// throws, because an invalid regex in a hand-edited config must not stop the
// server booting. Callers that get `{ error }` fall back to `basename`.
function compileBranchMatcher(pattern?: string | null, flags?: string | null): BranchMatcher {
  if (!pattern) return { error: 'featureIdentity.branchPattern is empty' };
  // `g`/`y` make exec() stateful via lastIndex — the same branch would match on
  // one call and miss on the next. Strip them; identity only ever wants the first match.
  const safe = String(flags || '').replace(/[gy]/g, '');
  let re: RegExp;
  try {
    re = new RegExp(String(pattern), safe);
  } catch (e) {
    return { error: (e as Error).message };
  }
  // A pattern with no capture group can only ever match, never extract, so it
  // would silently behave as `basename` for every worktree. Say so at load time.
  // `source + '|'` makes the pattern match the empty string without changing how
  // many groups it has, so the exec result's length counts them exactly — no
  // guessing at parentheses inside character classes or escapes.
  let groups = 0;
  try {
    // The `|` alternative makes this match unconditionally, so `m` is never null —
    // but a null would mean we learned nothing, which is the same as the catch below.
    const m = new RegExp(`${re.source}|`).exec('');
    groups = m ? m.length - 1 : 1;
  } catch {
    groups = 1;
  }
  if (groups === 0) return { error: 'featureIdentity.branchPattern has no capture group' };
  return { re };
}

// The first group that actually captured. A pattern with several groups
// (`^(?:fix|feat)/(\d+)-(.*)$`) is ambiguous, so the rule is stated rather than
// left to chance: the leftmost group that matched wins, and any later ones are
// ignored. `(?:…)` non-capturing groups are invisible here, which is the escape
// hatch for a pattern that needs grouping without claiming the identity.
// The parameter is `Array<string | undefined>`, not `RegExpMatchArray`, because
// lib.d.ts types the latter's elements as `string` and that is not true: a group that
// did not participate is `undefined` at runtime, which is the case this function
// exists to skip. A real match array still satisfies this (arrays are covariant), so
// nothing at a call site changes.
function firstCapture(m: Array<string | undefined> | null): string | null {
  if (!m) return null;
  for (let i = 1; i < m.length; i++) {
    const g = m[i];
    if (g !== undefined && g !== '') return g;
  }
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
/** `repo/<branch-or-wtname>` → the group's name */
function manifestIndex(groups?: GroupConfig[] | null): Map<string, string> {
  const byRef = new Map<string, string>();
  for (const g of groups || []) {
    if (!g?.name) continue;
    for (const ref of g.members || []) {
      if (typeof ref === 'string') byRef.set(ref, g.name);
    }
  }
  return byRef;
}

/**
 * Build the resolver for a config. Pure apart from the console.warn on a bad
 * config and the realpath calls behind the path index.
 */
function createIdentity(cfg: PartialDeep<Config> = {}): Identity {
  const layout = layoutMod.resolve(cfg);
  const fi = cfg.featureIdentity || {};
  const want = String(fi.strategy || 'basename');
  let strategy = STRATEGIES.find((s) => s === want);
  let warning: string | null = null;

  if (!strategy) {
    warning = `featureIdentity.strategy '${want}' is not one of ${STRATEGIES.join('/')}`;
    strategy = 'basename';
  }

  let re: RegExp | null = null;
  if (strategy === 'branch') {
    const c = compileBranchMatcher(fi.branchPattern, fi.branchFlags);
    // Presence of an error, not its truthiness: an empty message is still a failure
    // to compile, and treating one as a success left `re` unset with the strategy
    // still 'branch' — the one state the rest of this function assumes cannot happen.
    if (c.error !== undefined) {
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
  let manifestCache: { src: unknown; map: Map<string, string> } = { src: UNBUILT, map: new Map() };
  function manifestMap(): Map<string, string> {
    if (manifestCache.src !== cfg.groups) manifestCache = { src: cfg.groups, map: manifestIndex(cfg.groups) };
    return manifestCache.map;
  }

  // path → { repo, wtname, branch }, fed from the repo scan. Only built for the
  // strategies that need more than the path itself, so the default costs nothing.
  const index = new Map<string, IdentityInput>();
  // The shared memo (util.ts), not a local Map. Its rules are exactly the ones this
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
  function nameOf(w?: IdentityInput | null): string {
    if (!w) return '';
    if (w.wtname) return w.wtname;
    if (w.name) return w.name;
    return layoutMod.nameFromPath(layout, w.path);
  }

  function of(w?: IdentityInput | null): string {
    if (!w) return '';
    // `re` is non-null exactly when the strategy is still 'branch' — a pattern that
    // failed to compile rewrote strategy to 'basename' above. Testing the regex
    // rather than the strategy name is the same condition, stated where it is checkable.
    if (re && w.branch) {
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

  function ofPath(p?: string | null): string {
    if (!p) return '';
    if (needsIndex) {
      const hit = index.get(p) || index.get(realpaths.resolve(p));
      if (hit) return of(hit);
    }
    return layoutMod.nameFromPath(layout, p);
  }

  // Feed the index from a git scan (server/git.ts `scan()` output: repos, each
  // with .name and .worktrees[{ path, name, branch }]). Called after every rescan
  // so a worktree created, renamed or removed since boot resolves correctly.
  // A no-op under `basename`, which never consults the index.
  function reindex(repos?: IdentityScanRepo[] | null): void {
    if (!needsIndex) return;
    index.clear();
    const live = new Set<string>();
    for (const repo of repos || []) {
      for (const w of repo.worktrees || []) {
        const entry: IdentityInput = {
          repo: repo.name,
          wtname: w.wtname || w.name || path.basename(w.path),
          branch: w.branch,
          path: w.path,
        };
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

export { createIdentity, compileBranchMatcher, firstCapture, STRATEGIES };
