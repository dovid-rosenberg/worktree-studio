// Feature/group computation — ported from worktree-dash core.sh (242–274).
// A "feature" is a named unit owning one-or-more worktrees across repos:
//   - manual groups: config.groups [{name, members:["repo/branch-or-wtname"]}]
//   - auto groups:   feature identities shared across >= 2 worktrees
//   - features:      every unique linked worktree identity (singles included),
//                    minus names claimed by a manual group
// Main checkouts (wtname === repo) are never features. Each member is the full
// worktree object (with running/ports/session/etc) or a {missing,ref} stub.
//
// What makes two worktrees "the same feature" is server/identity.ts, not this
// file: grouping and concurrency-slot keying have to answer that question
// identically, so they share one resolver. Omitting it keeps the historical
// behavior (group by the worktree's directory name).
import { createIdentity } from './identity.ts';
import type { Identity } from './identity.ts';
import type { Feature, FeatureMember, GroupConfig, Worktree } from './types.ts';

/**
 * A feature as this module builds it. `session` is absent because only state.ts
 * knows the live sessions; it picks the driving one out of `members` and stamps it
 * on (along with `slot`) straight after calling computeFeatures.
 */
export type ComputedFeature = Omit<Feature, 'session'>;

const DEFAULT_IDENTITY = createIdentity({});

// linked = not the repo's main checkout
function isLinked(w: Worktree): boolean {
  return w.wtname !== w.repo;
}

function resolveRef(worktrees: Worktree[], ref: string): FeatureMember {
  const [repo, ...rest] = ref.split('/');
  const key = rest.join('/');
  const w = worktrees.find((x) => x.repo === repo && (x.wtname === key || x.branch === key));
  return w || { missing: true, ref };
}

// worktrees: flat array of worktree objects (all repos). manualGroups: config.groups.
// identity: a server/identity.ts resolver; defaults to the `basename` strategy.
function computeFeatures(
  worktrees: Worktree[],
  manualGroups: GroupConfig[] = [],
  identity: Identity = DEFAULT_IDENTITY,
): { features: ComputedFeature[]; groups: ComputedFeature[] } {
  const linked = worktrees.filter(isLinked);

  const manual: ComputedFeature[] = (manualGroups || []).map((g) => ({
    name: g.name,
    auto: false,
    members: (g.members || []).map((ref) => resolveRef(worktrees, ref)),
  }));
  const manualNames = new Set(manual.map((g) => g.name));

  // group linked worktrees by feature identity
  const byName = new Map<string, Worktree[]>();
  for (const w of linked) {
    const key = identity.of(w);
    const bucket = byName.get(key);
    if (bucket) bucket.push(w);
    else byName.set(key, [w]);
  }

  const auto: ComputedFeature[] = [];
  const autofeat: ComputedFeature[] = [];
  for (const [name, members] of byName) {
    if (manualNames.has(name)) continue;
    autofeat.push({ name, auto: true, members }); // every unique name (singles included)
    if (members.length >= 2) auto.push({ name, auto: true, members }); // only real multi-groups
  }

  const byRunning = (a: ComputedFeature, b: ComputedFeature) =>
    memberRunning(b) - memberRunning(a) || a.name.localeCompare(b.name);
  const features = [...manual, ...autofeat].sort(byRunning);
  const groups = [...manual, ...auto].sort(byRunning);
  return { features, groups };
}

function memberRunning(group: ComputedFeature): number {
  // `!m.missing` is the same test `m.running` already was: a {missing,ref} stub has
  // no `running` at all, so it never counted.
  return (group.members || []).filter((m) => m && !m.missing && m.running).length;
}

/**
 * Worktrees belonging to `feature` that a session's `repos` does not include.
 *
 * Feature membership and SESSION membership are different records. A feature groups
 * worktrees by identity; a session's `repos` is what the agent was granted with
 * /add-dir. A worktree made outside Studio (a plain `wt`) joins the feature and not the
 * session, and nothing notices — until Changes, which is session-scoped, renders an
 * empty diff, or the agent finds it cannot write to a repo it was started for.
 *
 * Identity is asked, not assumed: `of()` is what computeFeatures groups by, so this
 * reconciles on the same answer under `branch` and `manifest` as under `basename`,
 * rather than on names matching by luck.
 *
 * @param repos    the scan — repos each carrying their worktrees
 * @param feature  the session's feature identity
 * @param known    repo paths the session already has
 * @param of       the identity resolver's `of()`
 */
function attachableWorktrees(
  repos: {
    name: string;
    path: string;
    worktrees?: { name?: string; branch?: string | null; path: string; isMain?: boolean }[];
  }[],
  feature: string | null | undefined,
  known: Set<string>,
  of: (input: { repo: string; wtname?: string; branch?: string | null; path: string }) => string,
): { repo: string; repoPath: string; worktreePath: string; branch: string | null }[] {
  if (!feature) return [];
  const out = [];
  for (const repo of repos) {
    if (known.has(repo.path)) continue;
    for (const w of repo.worktrees || []) {
      if (w.isMain) continue;
      if (of({ repo: repo.name, wtname: w.name, branch: w.branch, path: w.path }) !== feature) continue;
      // One worktree per repo is what a feature member is.
      out.push({ repo: repo.name, repoPath: repo.path, worktreePath: w.path, branch: w.branch ?? null });
      break;
    }
  }
  return out;
}

export { computeFeatures, isLinked, resolveRef, attachableWorktrees };
