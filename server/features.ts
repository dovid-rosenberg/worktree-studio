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
import type {
  AttachableWorktree,
  Feature,
  SessionRepoGap,
  SplitFeature,
  FeatureMember,
  GroupConfig,
  Worktree,
} from './types.ts';

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
  /*
   * The PATHS a manual group has claimed — not its names.
   *
   * The dedupe below compared the auto-identity against manual group NAMES, which never
   * match a member's basename. So a group `{name:'mixed', members:['api/alpha','web/beta']}`
   * produced `mixed` AND `alpha` AND `beta`: three cards, each independently startable,
   * each taking its own concurrency slot. Under the `manifest` strategy the identities
   * happen to collapse to the group name and the name test appears to work, which is what
   * hid this for the one strategy anybody tested it with.
   *
   * A path is what a worktree IS, so it cannot fail to match the way a name can.
   */
  const claimed = new Set(
    manual.flatMap((g) => (g.members || []).map((m) => (m && 'path' in m ? m.path : ''))).filter(Boolean),
  );

  // group linked worktrees by feature identity
  const byName = new Map<string, Worktree[]>();
  for (const w of linked) {
    if (claimed.has(w.path)) continue; // already spoken for by a manual group
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
 * The scan, narrowed to what reconciliation reads. Written structurally rather than
 * imported from git.ts so a test can hand over four literals, as the callers' own
 * shapes (ScannedRepo, StateRepo) both satisfy it.
 */
type ScannedRepos = {
  name: string;
  path: string;
  worktrees?: { name?: string; branch?: string | null; path: string; isMain?: boolean }[];
}[];

/** A server/identity.ts resolver's `of()`. */
type IdentityOf = (input: { repo: string; wtname?: string; branch?: string | null; path: string }) => string;

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
  repos: ScannedRepos,
  feature: string | null | undefined,
  known: Set<string>,
  of: IdentityOf,
): AttachableWorktree[] {
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

/**
 * Sessions whose `repos` is a strict subset of their feature's worktrees.
 *
 * attachableWorktrees() has only ever been asked at promote time, which is one of the
 * three moments the two records can part company. The other two carry no such question:
 * a session ADOPTED into an existing feature never ran promote at all, and a worktree cut
 * later (a plain `wt`, an agent's own `git worktree add`) joins the feature long after
 * whatever moment might have asked. In both cases the feature card shows every repo and
 * the session knows fewer — and because Changes is session-scoped, the symptom is an
 * empty diff of a branch that genuinely has commits. An empty diff reads as "no changes",
 * not as "you are looking at the wrong record", so nothing on screen says the two
 * disagree. This is the scan-path half: asked on every scan, about every session.
 *
 * DETECT AND OFFER, not heal.
 *
 * Attaching is not a bookkeeping fix — attachRepo() sends `/add-dir` into a live agent,
 * which widens what it may read and WRITE, possibly mid-turn. Doing that automatically
 * from a background scan means the set of directories an agent can edit changes because
 * someone ran `wt` in another terminal, with no one having decided it should. The failure
 * being prevented here is the silent one (nobody knows the records disagree), and naming
 * the gap prevents it in full; closing it silently would trade a quiet wrong diff for a
 * quiet privilege change, which is the worse of the two. So: reported here, acted on by
 * SessionManager.attachRepos() behind an explicit button.
 *
 * Identity is asked, not assumed — the same resolver computeFeatures() groups by, for
 * the same reason attachableWorktrees() takes one.
 *
 * @param sessions the live sessions (manager.all())
 * @param repos    the scan — repos each carrying their worktrees
 * @param of       the identity resolver's `of()`; defaults to the `basename` strategy
 */
function detectSessionRepoGaps(
  sessions: Array<{
    id: string;
    title?: string;
    feature?: string | null;
    active?: boolean;
    repos?: Array<{ repoPath: string }>;
  }>,
  repos: ScannedRepos,
  of: IdentityOf = (i) => DEFAULT_IDENTITY.of(i),
): SessionRepoGap[] {
  const gaps: SessionRepoGap[] = [];
  for (const s of sessions || []) {
    // A deactivated session has no agent listening, so there is nothing to offer and
    // nothing the mismatch can currently mislead: its Changes panel is not on screen.
    // `active !== false` rather than `active`, so a caller handing over rows without the
    // field (a fake, an older store) is not silently filtered to nothing.
    if (s.active === false) continue;
    const known = new Set((s.repos || []).map((r) => r.repoPath).filter(Boolean));
    const missing = attachableWorktrees(repos, s.feature, known, of);
    // Equal sets, and a session with no feature yet, are not gaps — attachableWorktrees
    // answers [] for both, which is the whole test.
    if (!missing.length) continue;
    gaps.push({ sessionId: s.id, title: s.title || '', feature: s.feature || '', missing });
  }
  return gaps;
}

/**
 * Features that are obviously one piece of work under names that do not group.
 *
 * identity.ts groups by byte-identical worktree basenames across repos, and that
 * convention is load-bearing: Fleet grouping, concurrency slots, multi-repo sessions and
 * SwiftBar all key off it. Which is exactly why "same feature across repos → identical
 * worktree name" had to be written down as a rule for humans and agents to remember.
 * When one side gets named differently the feature silently splits in two — two slots,
 * two sets of ports, two cards for one job — and nothing reports it.
 *
 * The branch is the evidence the names threw away: worktrees cut for the same work
 * across repos are put on the same branch, by the same convention, and a branch survives
 * a renamed directory.
 *
 * DETECTION ONLY. Grouping is written to another tool's config file
 * (`~/.config/worktree-dash/config.json`), and a guess acted on silently is how the
 * naming convention became load-bearing without anyone deciding it should be.
 *
 * @param defaultBranches branch names that prove nothing — every worktree sits on one at
 *   some point, and grouping on them would propose merging a whole repo into one feature.
 */
function detectSplitFeatures(
  features: ComputedFeature[],
  defaultBranches: Set<string> = new Set(),
): SplitFeature[] {
  const byBranch = new Map<string, Array<{ feature: string; member: Worktree }>>();
  for (const f of features) {
    // A manual group is the user having already answered this; proposing it back to them
    // would be the tool arguing with its own configuration.
    if (!f.auto) continue;
    for (const m of f.members) {
      if (m.missing || !m.branch || defaultBranches.has(m.branch)) continue;
      const bucket = byBranch.get(m.branch);
      if (bucket) bucket.push({ feature: f.name, member: m });
      else byBranch.set(m.branch, [{ feature: f.name, member: m }]);
    }
  }

  const splits: SplitFeature[] = [];
  for (const [branch, hits] of byBranch) {
    const names = new Set(hits.map((h) => h.feature));
    if (names.size < 2) continue; // one name for one branch is the convention working
    // Two names inside ONE repo are two checkouts of a branch, not a cross-repo feature
    // that failed to group — a different thing, and not one to suggest merging.
    if (new Set(hits.map((h) => h.member.repo)).size < 2) continue;
    splits.push({
      branch,
      features: [...names],
      members: hits.map((h) => ({
        repo: h.member.repo,
        wtname: h.member.wtname,
        path: h.member.path,
        feature: h.feature,
      })),
    });
  }
  return splits;
}

export { computeFeatures, detectSplitFeatures, detectSessionRepoGaps, resolveRef, attachableWorktrees };
