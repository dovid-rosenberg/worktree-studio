# Awareness across features: collisions, drift, reviews, readiness

## Why

Studio is the only thing that knows about every worktree at once, and it has never
used that. Measured on the live checkout, 2026-08-11:

    iso-mfa-totp   x merchant-mfa              18 shared files  (helpers/mfa.js, models/iso_user/index.js)
    custom-reports x recurring-invoice-review   3 shared files
    block-merchant-surcharge x invoice-payments 2 shared files  (modules/surcharge.js)

    block-merchant-surcharge   behind master 27, ahead 1
    token-race-fix             behind 20, ahead 3
    recurring-invoice-review   ahead 33

Two agents are editing `helpers/mfa.js` in different worktrees right now and nothing
says so until one of them merges. That is the failure mode of running agents in
parallel, and it is invisible in every other tool.

## Phase 1 — collision radar + drift  ✅ LANDED

One piece of git plumbing answers both.

- [x] `server/overlap.ts`: per worktree, `merge-base` with the repo's default base,
      then `diff --name-only <mb>..HEAD`. Cache by `worktreePath + head sha` so a
      sweep is free when nothing moved.
- [x] Pairwise intersection per REPO (features only collide inside one repo).
- [x] Drift from the same primitives: `rev-list --count HEAD..base` (behind),
      `base..HEAD` (ahead), and the will-conflict set — files this branch changed
      that ALSO changed on base since the merge-base. That last set is the useful
      half: it is knowable before you rebase.
- [x] Ride the `ci` frame's cadence (feed + TTL + "only when someone is watching"),
      not the topology broadcast — this shells out per worktree.
- [x] Rail card: quiet badge when a feature shares files with another.
- [x] Dock chip: `18 files also changed by iso-mfa-totp`, click to list them.
- [x] Drift badge `behind 27` on the rail card; the conflict set in the dock.
- [x] Tests: fixture repos with real overlapping worktrees; assert the pair math and
      that a clean feature reports nothing.

## Phase 2 — send a failing run to the agent

- [ ] Button on a failed run in RunsPanel: pipe the log tail into the session's pane
      via `sendWhenReady` (already exists, already gated on claude being ready).
- [ ] Include the command, the exit code and the tail — not the whole log.
- [ ] Only for a session that has an agent; a feature without one has nowhere to send.

## Phase 3 — review queue + how it sits in the rail

**The open design question.** MRs awaiting your review are not features and usually
have no local worktree, so they are a new kind of rail row.

- [ ] `glab mr list --reviewer=@me` (and the `gh` equivalent) through forge.ts.
- [ ] A `kind: 'review'` rail row: title, repo, author, MR number, checks.
- [ ] Grouping: the owner asked for it "in the sort options". The rail's own rule is
      NO BUCKETS (see Rail.svelte) with a single divider for idle rows — so the
      cheapest honest fit is a `RAIL_SORTS` entry (`mine` / `reviews`) that sorts
      reviews into their own run, marked by the same divider device.
- [ ] Selecting a review row: open the MR, or offer to check it out as a worktree.

## Phase 4 — ship readiness

- [ ] One per-feature verdict composing what Phases 1 and 3 already fetch: every
      repo's MR open?, checks green?, approvals?, behind-by, unpushed commits.
- [ ] Renders where the feature is already named — the dock bar — not a new panel.

## Not doing now

- Asana write-back (moving the task on MR open/merge). Explicitly deferred by the
  owner. It needs write scopes and a per-workspace column mapping.

## Review

**Phase 1 landed.** 9 tests in `test/overlap.test.ts`, against real git repos rather
than canned file lists — the trap worth catching is diffing `base..HEAD` instead of
`mergeBase..HEAD`, which folds every commit made on master into "files you changed" and
makes every feature collide with every other. One test moves master underneath a branch
and asserts the feature still reports exactly the one file it edited.

Two decisions worth keeping:
- `FeatureOverlap` is declared in `types.ts`, not `overlap.ts`. The client typechecks
  against the wire contract, and `overlap.ts` imports `./util.ts` with an extension the
  client's tsconfig rejects — so the producer imports the shape, not the reverse.
- Measured against `origin/<default>`, not the local base branch: a stale local master
  makes every branch look up to date.

Next: Phase 2 (send a failing run to the agent) is small and independent. Phase 3 still
carries the one open question — how review rows sit in the rail.
