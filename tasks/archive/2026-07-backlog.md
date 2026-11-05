# Backlog — everything open, in priority order

Written 2026-07-28. Supersedes the scattered "open" markers in `v3-plan.md` §1–§3;
that file keeps the *reasoning* behind each item, this one is the queue.

Ordering is by payoff-per-effort for the actual workflow (many agents, many repos,
watched at a glance), not by area.

---

## Status 2026-07-29

**P0, P1 and P2 are done.** P3 is most of the way there: the client has a test runner
and 62 tests, the server has a smoke suite that boots a real daemon, and identity has
property tests. What is left is listed at the bottom under "Still open".

### Still open

- **`/group/pr` loops members serially** (P3 #16). Deliberately NOT changed: verifying
  a parallel version means opening real pull requests, and the path is network-mutating
  with documented secondary-rate-limit risk on concurrent mutations. Timeouts already
  bound each member, so the cost is cumulative latency, not a hang. Worth doing with a
  small concurrency cap when someone can watch it against a real remote.
- **The two unreproduced test failures** from the v2 build-out (P3 #16). Still not
  reproduced; nothing to act on until they recur.
- ~~Component coverage for Dock and FeaturePane~~ — done. Every surface that took
  feedback now has a test that fails if it regresses; 87 client tests across ten files.
- **Property tests for hunk math** (P3 #15). Lower value than identity was: every hunk
  subset already round-trips through `git apply --check` in hunks.test.ts, which is a
  stronger check than a property could state.

---

## Done since this was written (2026-07-28)

- **P0 entirely** — flat rail, two signals per card, actions at the bottom only.
- **P1 entirely** — Overview deleted, Insights decoupled and archived, split closable
  from inside, FeaturePane reads instead of duplicating.
- **P2 #9–#13** — mux badge, `reattached`, terminal theming, summary-bar counts, one
  verb for starting servers.
- **P3 #14 started** — the client has a test runner and 33 tests across two layers.
- **Not on this list when it was written**: `canStart` is deps-aware, and the six
  worktrees missing node_modules are installed.

- **`startFeatureSession` selection bug** — wrote `selectedId` without clearing
  `selectedFeatureName`, so starting an agent from a sessionless feature left the
  feature table on screen. Fixed.
- **⌘1–9 selected the wrong card** — `railOrder` was agents-then-features while the
  rail draws servers, mains, agents, features. Rebuilt from the rendered sections.
- **Terminal follows the theme** (#11 below) — both palettes were dark.

---

## Done — the whole prioritised queue, verified 2026-08-03

**P0, the rail (1–4).** One row per thing, the bottom section renamed and widened to
hold everything not running, six status indicators distinguished rather than three, and
the actions collected in the ActionBar instead of appearing in two places. Pinned by
`Rail.test.ts`, `FeatureCard.test.ts`, `SessionCard.test.ts`, `ActionBar.test.ts`.

**P1 (5–8).** Overview deleted (`'overview'` has no references left), Insights is an
archive that survives worktree removal, the split closes with its last tab, FeaturePane
lost its duplicate buttons and gained the commits/uncommitted rollup.

**P2 (9–13).** `mux: tmux` gone, `reattached` gone (only an explanatory comment
remains), the terminal follows the theme, the summary bar splits its two vocabularies,
the verbs renamed.

**P3 (14–15a).** The client had zero tests and now has 89.

**Found and fixed while using it (2026-08-03).**
- *Promote stranded work.* Uncommitted edits were warned about and left behind; commits
  were left behind silently. Both are now one question and either can come along —
  changes by stash, commits by cutting the branch from HEAD. `promote-changes.test.ts`.
- *A missing start command explained nothing.* `canStart` is `!!startCfg &&
  !depsMissing` and only the deps half said so on screen, so an absent Run stack button
  read as stale deps. Both halves report now. Found live on `su-mfa-cleanup`/`ab-su`.
- *Session repos drifted from feature worktrees.* A worktree made with a plain `wt`
  joins the feature but not the session, so Changes — which is session-scoped — showed
  an empty diff of a genuinely empty worktree, and the agent could not write to repos it
  was started for. Promote now offers to attach them. `attachable.test.ts`.

---

## Still open

### `/group/pr` runs members serially
A wedged member delays its siblings. Parking it was deliberate: verifying a change needs
real PRs against a real forge, and doing it blind risks tripping rate limits on David's
actual repos. Needs a live remote to test against, not more reasoning.

### Reconcile session repos outside promote
`attachableWorktrees()` runs on promote. The same gap exists for a session *adopted*
into an existing feature, and the rail still shows no sign of the mismatch — it is
invisible until a diff comes back empty. The same reconciliation, at two more moments.
