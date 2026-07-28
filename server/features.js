// Feature/group computation — ported from worktree-dash core.sh (242–274).
// A "feature" is a named unit owning one-or-more worktrees across repos:
//   - manual groups: config.groups [{name, members:["repo/branch-or-wtname"]}]
//   - auto groups:   feature identities shared across >= 2 worktrees
//   - features:      every unique linked worktree identity (singles included),
//                    minus names claimed by a manual group
// Main checkouts (wtname === repo) are never features. Each member is the full
// worktree object (with running/ports/session/etc) or a {missing,ref} stub.
//
// What makes two worktrees "the same feature" is server/identity.js, not this
// file: grouping and concurrency-slot keying have to answer that question
// identically, so they share one resolver. Omitting it keeps the historical
// behavior (group by the worktree's directory name).
import { createIdentity } from './identity.js';

const DEFAULT_IDENTITY = createIdentity({});

// linked = not the repo's main checkout
function isLinked(w) { return w.wtname !== w.repo; }

function resolveRef(worktrees, ref) {
  const [repo, ...rest] = ref.split('/');
  const key = rest.join('/');
  const w = worktrees.find((x) => x.repo === repo && (x.wtname === key || x.branch === key));
  return w || { missing: true, ref };
}

// worktrees: flat array of worktree objects (all repos). manualGroups: config.groups.
// identity: a server/identity.js resolver; defaults to the `basename` strategy.
function computeFeatures(worktrees, manualGroups = [], identity = DEFAULT_IDENTITY) {
  const linked = worktrees.filter(isLinked);

  const manual = (manualGroups || []).map((g) => ({
    name: g.name,
    auto: false,
    members: (g.members || []).map((ref) => resolveRef(worktrees, ref)),
  }));
  const manualNames = new Set(manual.map((g) => g.name));

  // group linked worktrees by feature identity
  const byName = new Map();
  for (const w of linked) {
    const key = identity.of(w);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(w);
  }

  const auto = [];
  const autofeat = [];
  for (const [name, members] of byName) {
    if (manualNames.has(name)) continue;
    autofeat.push({ name, auto: true, members }); // every unique name (singles included)
    if (members.length >= 2) auto.push({ name, auto: true, members }); // only real multi-groups
  }

  const byRunning = (a, b) => memberRunning(b) - memberRunning(a) || a.name.localeCompare(b.name);
  const features = [...manual, ...autofeat].sort(byRunning);
  const groups = [...manual, ...auto].sort(byRunning);
  return { features, groups };
}

function memberRunning(group) {
  return (group.members || []).filter((m) => m && m.running).length;
}

export { computeFeatures, isLinked, resolveRef };
