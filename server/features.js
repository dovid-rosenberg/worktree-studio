'use strict';
// Feature/group computation — ported from worktree-dash core.sh (242–274).
// A "feature" is a named unit owning one-or-more worktrees across repos:
//   - manual groups: config.groups [{name, members:["repo/branch-or-wtname"]}]
//   - auto groups:   linked worktree names shared across >= 2 worktrees
//   - features:      every unique linked worktree name (singles included),
//                    minus names claimed by a manual group
// Main checkouts (wtname === repo) are never features. Each member is the full
// worktree object (with running/ports/session/etc) or a {missing,ref} stub.

// linked = not the repo's main checkout
function isLinked(w) { return w.wtname !== w.repo; }

function resolveRef(worktrees, ref) {
  const [repo, ...rest] = ref.split('/');
  const key = rest.join('/');
  const w = worktrees.find((x) => x.repo === repo && (x.wtname === key || x.branch === key));
  return w || { missing: true, ref };
}

// worktrees: flat array of worktree objects (all repos). manualGroups: config.groups.
function computeFeatures(worktrees, manualGroups = []) {
  const linked = worktrees.filter(isLinked);

  const manual = (manualGroups || []).map((g) => ({
    name: g.name,
    auto: false,
    members: (g.members || []).map((ref) => resolveRef(worktrees, ref)),
  }));
  const manualNames = new Set(manual.map((g) => g.name));

  // group linked worktrees by name
  const byName = new Map();
  for (const w of linked) {
    if (!byName.has(w.wtname)) byName.set(w.wtname, []);
    byName.get(w.wtname).push(w);
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

module.exports = { computeFeatures, isLinked, resolveRef };
