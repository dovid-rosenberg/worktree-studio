# Worktree Studio — full review, August 2026

Pinned at commit `5ce2f4c`. Produced by 15 independent reviewers across three axes, with an
adversarial verification pass over the highest-severity functional claims.

| | Raw findings | Items after dedupe | Detail |
|---|---|---|---|
| Code style / duplication | 67 | **60** | [`01-code-style.md`](01-code-style.md) |
| Functionality (bugs) | 46 | **39** | [`02-functionality.md`](02-functionality.md) |
| Design / UX | 42 | **29** | [`03-design.md`](03-design.md) |

Severity across the raw set: **6 critical · 36 high · 66 medium · 47 low**.

Twelve highest-severity functional claims went to adversarial verifiers instructed to *refute*
and to default to refuted when they could not substantiate. **10 confirmed, 2 partly confirmed,
0 refuted.** That is an unusually clean verification rate. Treat it as a signal that the
functional findings are real, not as licence to skip reading the repro steps.

---

## Honest assessment

**This is a healthy codebase with a specific, recurring weakness.**

155 findings across ~38k lines is not an alarming density, and the shape matters more than the
count: two thirds are medium or low, and a large share of those are consistency and polish
rather than defects. The architecture is sound. The module boundaries mostly hold. The test
suite is real (708 server + 149 client) and it caught things during this review.

The weakness is singular and it runs through everything:

> **One rule gets implemented in several places, and the copies drift.**

That is not a new diagnosis. It is the same failure that produced the three divergent
slot-release rules, the two copies of the start verdict, the three HTTP wrappers, and the
`canStart` split — all found and fixed in the weeks before this review. What the review shows is
that **the pattern was never systematically swept**, only fixed where it happened to bite. The
duplication track (STYLE-01 through STYLE-26) is a list of the ones still live, and several have
already drifted, which makes them bugs rather than tidiness.

The six criticals are all in one family too: **the daemon can be killed by a single HTTP
request** (BUG-01), and **stopping one feature can kill another feature's servers** (BUG-03).
Both are in `servers.ts`. Neither is exotic — they are ordinary paths, not edge cases.

The design track is the least mature axis. Not because the UI is bad, but because it has been
built by accretion under time pressure, and the review found the predictable results: a colour
system with two tokens that are the same colour in dark mode (UX-07), status pills failing WCAG
AA in light mode (UX-08), and a control whose visual weight is inverted against its consequence
(UX-06). These are cheap to fix and disproportionately improve the feel.

**What this review does not cover.** The design reviewers could not run the app; every finding
they marked *inferred* is reasoning from source, not observation. The functional reviewers built
real sandboxes and drove the real HTTP API, so their *reproduced* findings are trustworthy —
but read each item's confidence marker before acting. `02-functionality.md` carries a section
near the top stating exactly what was and was not exercised.

---

## Working safely in this repo

Read this before assigning anything.

- **Another agent commits to this checkout concurrently.** Two teams editing `server/sessions.ts`
  at the same time is a merge disaster. See the collision matrix under *Tracks*.
- **A live daemon runs on port 7788 and the owner is using it.** Never kill it, never rebind it.
  Sandbox work must use a different port and redirect `HOME` and `WT_STUDIO_STATE`.
- **The gate is:** `npm test` (708 server + 149 client), `npx tsc --noEmit`, and
  `cd client && npx svelte-check`. All three must be clean.
- **`npm run lint` currently exits 1** with 4 errors and 33 warnings. STYLE-02 fixes the errors.
  Until it lands, "lint is red" is the expected state and tells you nothing — which is precisely
  why it should be fixed first.
- **Branch off `main`.** Never commit to `main` directly. No AI-attribution trailers.

---

## Do this first

Five items. Chosen for value-to-risk, not for size — each is small, well-understood, and either
prevents a crash or unblocks other work.

| Item | Why it goes first |
|---|---|
| **BUG-01** — `Servers.start()` spawns with no `'error'` listener | One HTTP request can take down the whole daemon, losing every terminal. A three-line fix against a total-loss failure. Highest value-to-risk in the review. |
| **BUG-03** — `stop()` falls back to slot-0 ports | Stopping one feature SIGTERMs *another feature's* dev servers. Silent, confusing, and actively destructive to work in progress. |
| **STYLE-02** — 4 dead-code lint errors | Trivial, but it makes `npm run lint` meaningful again. While it is red, no future team can use lint as a signal. Do it before anything else so every later branch inherits a clean gate. |
| **BUG-02 / BUG-06** — `deleteBranches: true` silently does nothing on unmerged branches | Reports success, deletes nothing. The exact "said it worked, did nothing" family this codebase has been fighting; leaving it undermines trust in every other confirmation. |
| **UX-07 + UX-08** — `--muted`/`--faint` identical in dark; status pills fail AA in light | Two token edits in `app.css`. Fixes the app's core state vocabulary being illegible, and touches no logic, so it cannot conflict with any other track. |

Do **STYLE-02** first of all. It is five minutes and it restores a gate everyone else depends on.

---

## Tracks

Five tracks, ownable by separate teams. The collision matrix below is the important part.

### Track A — Crash and data-loss (start here)
**Files:** `server/servers.ts`, `server/concurrency.ts`
**Items:** BUG-01, BUG-03, BUG-04, BUG-05, and the slot-lifecycle items in `02-functionality.md`.
**Why grouped:** all in the dev-server lifecycle, all in one or two files. Splitting them across
teams guarantees conflicts.
**Acceptance:** a malformed start command cannot kill the daemon; stopping feature A never
touches feature B's ports; a slow-starting server keeps its slot.

### Track B — Honest reporting
**Files:** `server/worktree.ts`, `server/sessions.ts`, `server/routes-review.ts`
**Items:** BUG-06, BUG-07, BUG-08, and the remaining "reports success, does nothing" items.
**Depends on:** nothing, but **collides with Track D** on `sessions.ts`. Sequence them.
**Acceptance:** every operation that answers `ok: true` has done what the caller asked, or names
what it did not do.

**BUG-07 deserves separate mention:** `POST /sessions/:id/commit` runs `git add -A`, discarding
the hunk-level staging the review UI just spent effort collecting. A user who carefully staged
three hunks out of nine gets all nine committed. That is silent destruction of user intent, and
it is worse than the criticals in practice because it is *quiet*.

### Track C — Duplication sweep
**Files:** broad but shallow — `server/*.ts`, `client/src/lib/**`
**Items:** STYLE-01 through STYLE-26.
**Order matters:** do the **drifted** copies first (STYLE-12, STYLE-26, STYLE-04) — those are
bugs. Then the agreeing copies (STYLE-15, STYLE-03) — those are tidiness.
**Collides with:** everything, because it touches many files shallowly. **Run this track alone**,
or restrict it to files no other track owns.
**Acceptance:** each rule has exactly one implementation; every former copy is a call to it.

### Track D — Session lifecycle and first run
**Files:** `server/sessions.ts`, `server/config.ts`, `README.md`, `MANUAL.md`
**Items:** UX-02, the `copyPatterns` `.ts`/`.js` mismatch, the docs findings from the first-run
reviewer, and STYLE-01 (the four-times-spelled launch ritual).
**Collides with:** Track B on `sessions.ts`.
**Acceptance:** a new user on a clean machine reaches a working session by following the docs
literally, with no undocumented step.

### Track E — Design and accessibility
**Files:** `client/src/app.css`, `client/src/lib/components/**`
**Items:** UX-01 through UX-29.
**Depends on:** nothing. **Collides with:** nothing in Tracks A–D. Safe to run fully parallel.
**Order:** tokens first (UX-07, UX-08 — they change everything downstream), then layout
(UX-05, UX-03), then language last (the vocabulary table, which is mechanical once agreed).
**Acceptance:** WCAG AA contrast in both themes; no meaning conveyed by colour alone; one term
per concept across every user-facing string.

### Collision matrix

| | A | B | C | D | E |
|---|---|---|---|---|---|
| **A** Crash | — | ok | **CONFLICT** | ok | ok |
| **B** Honest reporting | ok | — | **CONFLICT** | **CONFLICT** (`sessions.ts`) | ok |
| **C** Duplication | **CONFLICT** | **CONFLICT** | — | **CONFLICT** | ok |
| **D** Lifecycle | ok | **CONFLICT** | **CONFLICT** | — | ok |
| **E** Design | ok | ok | ok | ok | — |

**Practical schedule:** run **A + E** together first (no overlap, highest value). Then **B**, then
**D**. Run **C alone** at the end, when the files it rewrites have stopped moving — a duplication
sweep against a moving target is how you get a fourth copy instead of one.

---

## Do NOT do

As valuable as the do-list. Each of these was proposed by a reviewer and should be declined.

- **Do not strip comments.** Several style reviewers flagged the high comment ratio. Most of it is
  load-bearing — it explains *why* a non-obvious choice was made, usually citing a real bug. The
  correct target is **stale** comments describing deleted code; those are defects. Volume is not.
- **Do not split `server/server.ts` by line count.** It is large, but it is a *wiring* file for a
  single-user local tool. Splitting relocates lines without removing a concept and risks
  route-registration bugs for no felt gain. Extract a route group only when one grows its own
  cohesion, as `orchestrator`/`forge`/`routes-review` already did.
- **Do not restructure `types.ts`.** 933 lines imported by 27 modules is a shared contract. That
  is the point of it.
- **Do not adopt the proposed generic "resource route factory".** It would abstract over four
  routes that differ in every meaningful way. That is the disease this review is treating, not
  the cure.
- **Do not act on the 2 "partly confirmed" findings as written** — BUG-04 (slot lost to a slow
  start) and the detached-HEAD `defaultBranch` item. Both are real but the reviewer's stated
  mechanism was wrong. The corrections are folded into the item text in
  [`02-functionality.md`](02-functionality.md); read those before starting.
- **Do not treat the design track's *inferred* findings as observed fact.** The design reviewers
  could not run the app. Verify in the browser before rewriting layout on the strength of an
  inference.

*(Nothing was refuted outright — all 12 verified claims survived. There is no "refuted" list.)*

---

## A note on what this review found about recent work

Three items land directly on changes made in the days before this review, and they are worth
calling out so they are not mistaken for old debt:

- **UX-01** — "◉ Waiting" is inert for promoted features, and waiting agents do not actually sort
  to the top. That feature was added recently and does not work as intended.
- **UX-05** — the newly consolidated dock bar **wraps**, so selecting a different row changes the
  terminal's height. The consolidation was right; the overflow behaviour was not considered.
- **STYLE-02** — three of the four lint errors are unused imports and variables left behind by
  recent refactors (`orchestrator.ts:16`, `server.ts:35`, `state.ts:270`).

Fresh code is where review pays best. None of these is serious; all three are cheap.
