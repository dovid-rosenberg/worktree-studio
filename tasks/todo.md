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

## Phase 1 — drift  ✅ LANDED (collision half removed)

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

## Phase 2 — send a failing run to the agent  ✅ LANDED

- [x] Button on a failed run in RunsPanel: pipe the log tail into the session's pane
      via `sendWhenReady` (already exists, already gated on claude being ready).
- [x] Include the command, the exit code and the tail — not the whole log.
- [x] Only for a session that has an agent; a feature without one has nowhere to send.

## Phase 3 — review queue + how it sits in the rail  ✅ LANDED

**The open design question.** MRs awaiting your review are not features and usually
have no local worktree, so they are a new kind of rail row.

- [ ] `glab mr list --reviewer=@me` (and the `gh` equivalent) through forge.ts.
- [x] A `kind: 'review'` rail row: title, repo, author, MR number, checks.
- [x] Grouping: the owner asked for it "in the sort options". The rail's own rule is
      NO BUCKETS (see Rail.svelte) with a single divider for idle rows — so the
      cheapest honest fit is a `RAIL_SORTS` entry (`mine` / `reviews`) that sorts
      reviews into their own run, marked by the same divider device.
- [x] Selecting a review row: open the MR, or offer to check it out as a worktree.

## Phase 4 — ship readiness  ✅ LANDED

- [x] One per-feature verdict composing what Phases 1 and 3 already fetch: every
      repo's MR open?, checks green?, approvals?, behind-by, unpushed commits.
- [x] Renders where the feature is already named — the dock bar — not a new panel.

## Not doing now

- Asana write-back (moving the task on MR open/merge). Explicitly deferred by the
  owner. It needs write scopes and a per-workspace column mapping.

## Review

**Phase 1: the collision half was removed at the owner's request.** The data was right —
18 shared files between two live features on the day it shipped — but the warning was not
wanted, so the pairwise intersection and `collisions` went with the UI rather than being
left computing into a surface nobody renders. Drift stayed: it is a fact about your own
branch, not a warning about somebody else's.

Original notes, still true of the drift half: 9 tests in `test/overlap.test.ts`, against real git repos rather
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

**Phase 2 landed.** The design turned on one constraint found while building it: tmux's
`sendText` writes the body literally and presses Enter SEPARATELY, so any newline in the
message submits it half-written — a pasted stack trace would arrive as fifty
half-messages. So the handoff is one line pointing at the log file, which is better
anyway: the agent reads all of the output rather than a guessed tail. The first test
asserts the message contains no newline, because that is what the whole design rests on.

The session is resolved from the RUN's worktree, server-side. A client naming the target
would let a stale tab hand a failure to whichever agent it last had selected.

**Phase 3 landed: option B.** Reviews are their own group, always, below your work under
a `waiting on you · N` divider. Not a sort option — making the grouping one of five sorts
means it is undone by choosing any of the other four, including the default. The sort
still does its one job: it orders each side of the split.

`Check out & review` cuts a worktree at the MR's source branch and seeds a session to read
the diff and report findings without changing anything. The worktree is named after the MR
and never after the branch: a feature is "worktrees sharing a name", so the branch name
would fold somebody else's merge request into your own feature.

**Phase 4 landed.** `lib/ship.ts` is a pure function over data already on the client, so
the verdict costs no request and no state. The rule it defends: it never says READY on
missing data — a forge that declines to report mergeability yields `unknown`, because
everything visible looks fine and that is exactly when the shortcut is tempting.

Two things had to be added to answer it honestly: the forges' own merge verdicts (already
in the JSON those calls fetch, so no extra round trip) and a count of commits
`origin/<branch>` does not have — the blocker no forge can see, since a forge describes
what it was pushed.

**All four phases are done.** What is left in the original list is Asana write-back, which
the owner deferred, and the collision half of Phase 1, which was built and then removed at
their request.

---

# Slot targeting without touching the repo  ✅ LANDED

## Why

Studio encoded per-slot state by rewriting a file the vanilla toolchain also reads.
`applyConfigPatch` rewrote `localhost:1239` → `localhost:1339` inside a frontend's
gitignored `src/config.js` and never reverted it, so the last slot a worktree ran at
survived the feature that made it.

Reported 2026-08-25: `merchant-mfa` opened in WebStorm — no Studio involved — failed
every API call with `ERR_CONNECTION_REFUSED` on `POST localhost:1339/merchant/auth/login`.
Its config had been patched to slot 1 at some earlier point and nothing runs on 1339
unless Studio starts it. Six of seven merchant-v3 worktrees carried a patched port;
three were off-base.

## What changed

- [x] `server/slot-rewrite.ts` — `portRefRe` / `rewriteSiblingPort` /
      `rewriteAllSiblingPorts` extracted so the daemon and the Vite wrapper (separate
      processes) share one definition of "a reference to a backend port".
      `concurrency.ts` re-exports them, so no existing importer or test moved.
- [x] `server/slot-vite-config.mjs` — Studio's own Vite config, outside every repo.
      Wraps the worktree's config (`vite.config.local.mjs` preferred, else
      `vite.config.js`) and adds one `enforce: 'pre'` transform that substitutes the
      slot's ports **as the module is served**. Nothing is written to the worktree.
- [x] `RepoConcurrency.slotConfig` (types.ts) — the in-memory mapping. Wins over
      `configPatch` when both are present.
- [x] `launchOpts` returns a path-free `SlotConfigPlan`; `slotConfigLaunch` resolves it
      against the worktree into `--config <wrapper>` + `WTS_SLOT_VITE`; `start()`
      appends it exactly as it already appended `portArgs`.
- [x] `wiredPorts` **derives** the family from the slot for a `slotConfig` repo instead
      of reading the file back. Reading is meaningless once nothing writes — it would
      report every frontend as wired to slot 0. `wiredTo` and all four `WiredStatus`
      values are unchanged and still catch a foreign process on the slot's port.
- [x] Config migrated: `merchant-v3` + `ab-su` to `slotConfig`, start commands reduced
      to `exec npx vite`. `ab-iso-fe` (webpack-dev-server) deliberately left on
      `configPatch`.
- [x] One-time reset of the three off-base worktrees (`merchant-mfa` 1339,
      `custom-reports` 1339, `fix-google-pay-mobile` 1439) back to 1239.

## Review

`npm run verify` green: lint, format, typecheck (server + client), 1108 server tests
(1089 pre-existing, unchanged, + 19 new) and 302 client tests.

End-to-end against the live config, one worktree at slot 1, same file same instant:

    SERVED via wrapper (:3130)   baseURL localhost:1339   verifyUrl 1339   legacyUrl 3030
    ON DISK (WebStorm reads)     baseURL localhost:1239   verifyUrl 1239   legacyUrl 3030

The port families move together, `legacyUrl:3030` and `localhost:12390` are untouched
(the `(?![0-9])` guard), and slot 0 is a no-op that returns `null` rather than an
identical rewrite.

## Not done

- **`ab-iso-fe`** still rewrites on disk. webpack-dev-server needs its own out-of-repo
  `--config` wrapper plus a module rule applying the same rewrite. Until that lands,
  `applyConfigPatch` cannot be deleted and iso worktrees keep the old failure mode.
- **Editor run configurations** (`LaunchOpts.cmd`) replace the start command, so such a
  launch gets neither `configArgs` nor `portArgs` and is not slot-targeted at all.
  Pre-existing for `portArgs`; worth a decision rather than a silent gap.
- **`/branding/logo.png` 404** on localhost is unrelated to slots
  (`src/utils/index.js:209` returns `/branding/<file>` and no `public/branding/` exists).
  Not folded in: fixing it with a dev-server proxy would reintroduce exactly the
  Studio-behaves-differently-from-vanilla split this change removes.
