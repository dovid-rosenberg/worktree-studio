# Worktree Studio — queued work

Everything below is **after** the ESM/TypeScript migration (`chore/esm-typescript`) merges.
Both tracks touch `client/`, so running them concurrently would fight the migration.

---

## 1. UI/UX pass

From a review of the running app at 1440×900 (Work + Fleet). Ordered by payoff.

### 1.1 Fleet: delete the `SERVERS RUNNING` section — the main fix

`custom-reports` and `fix-recurring-deleted-pm` each render **twice**: once under
`SERVERS RUNNING · 3`, again under `WORKTREES · 7`. The duplicates disagree with each
other — different button order, different port formatting (`accept-blue:1331 accept-blue:1332…`
above vs `accept-blue feature/schedule-reports :1331 :1332…` below), and only the lower
row has the `⋯` overflow.

The section exists to surface **one** non-duplicated row: `ab-iso-fe MAIN`, a main
checkout with no worktree. Two duplicate rows and a section header to surface one
special case.

- Remove the section; sort running features to the top of `WORKTREES`.
- Give main-checkout servers a small dedicated strip, or fold them in using the
  `MAIN` badge they already carry.
- **One row per thing, always.**

### 1.2 Summary bar: hide zeros, separate the two vocabularies

`7 features · +0 unpromoted · 3 running · 0 working · 3 waiting`

- Zero counts get the same visual weight as real ones — two reads to learn nothing.
- It doesn't add up: 3 + 0 + 3 ≠ 7. `running` counts **servers**; `working`/`waiting`
  count **agents**. Presented as one comma-run they read as parts of a whole.

Hide zero counts. Split agent state from server state visually.

### 1.3 Pills: show only non-default state

`⇅ servers · stopped` appears on 4 of 7 rows — the label is constant, the value is the
default, so those rows announce that nothing is happening. Same for `agent · idle`.

Render a pill only when state is non-default. Absence means stopped/idle. This is what
lets `agent · waiting` — the one state that actually wants the user — stop competing
with six neighbours.

### 1.4 One verb per concept; green means state, not action

Three vocabularies today: `Stop stack` vs `Stop`, `Run stack` vs `Start session`. And
`Run stack` is green while `Start session` is tan, though both start something — so
green currently means both "is running" (state) and "start this" (action).

Nine actions per row (4 inline + 5 in `⋯`). Inline should hold the one or two actually
reached for; the rest belong in the overflow.

### 1.5 Work view

- **`Pop out` appears twice** — header and tab strip, ~100px apart.
- **`reattached` on every rail card** — identical across all three, so a line per card
  carrying zero information.
- **Group headers duplicate their only child** (`MERCHANT-MFA` above `merchant-mfa`).
  Show the header only when a feature has 2+ sessions.
- **The tab strip mixes two kinds of thing**: `Changes`/`Logs`/`Insights` swap the panel,
  `+` spawns a terminal. Same affordance, different behaviour — separate them visually.

---

## 2. Test coverage

Measured on 542 tests / 32 files. Server-side integration coverage is genuinely strong —
real git repos, real tmux, real child processes, real `lsof`; `hunks.test.js` feeds every
hunk subset back through `git apply --check`; `no-regression.test.js` reimplements replaced
functions verbatim and asserts equality over a corpus. The bias toward integration over
unit is **correct** for a process orchestrator. The gaps are elsewhere.

### 2.1 Client tests — zero, and the SvelteKit UI now ships

41 components, no `vitest`, no `testing-library`, no `playwright`. `svelte-check` is type
checking, not testing.

Every UI bug found during the v2 build-out — two broken auth layers, the placeholder dock
mounts, the terminal reopening its WebSocket on every frame — was found by manually driving
a browser. **None of it is repeatable.** Highest-value gap.

Start with `world.svelte.js` (the SSE stitching already had one real bug) and Fleet/Rail
rendering.

### 2.2 End-to-end — 2 tests, both server-only

`crash` and `rescan` spawn the real daemon. Nothing exercises the browser against the real
stack. Encode what agents verified by hand, as ~6 Playwright tests:

boot → load UI → select session → terminal round-trips input → open Changes → stage a hunk
→ search a transcript.

### 2.3 Property testing — absent where it is obviously right

`server/diff.js` is a pure parser with a serializer, and the invariant is already written
by hand ~8 times: parse → `formatFilePatch` → `git apply --check` accepts. `fast-check`
would generate thousands of cases including malformed patches nobody thought of.

Same shape for hunk-subset selection and the byte-offset arithmetic in `transcripts.js`
(chunk boundaries, half-written tails, file shrink).

### 2.4 Smoke — none in the suite

Nothing asserts "daemon boots, serves `/`, answers `/api/v1/state`, emits all three SSE
frames." That is the check most likely to catch a catastrophic regression, and it is
currently run by hand after every restart.

### 2.5 Chaos — exists ad hoc, not systematized

Already present and worth naming as a group: `timeouts.test.js` drives a fake `git` that
sleeps 300s and asserts the child is reaped; `crash.test.js` occupies a port; the restore
test uses a state dir where saving fails. Extend to: tmux killed out from under a session,
`lsof` unavailable, state dir read-only, disk full, a dev server that binds then dies.

---

## 3. Known deferred items

- **`/group/pr` loops members serially.** Timeouts bound it, but a wedged member still
  delays its siblings. Parallelising changes behaviour (gh rate limits, interleaved output).
- **`pruneTracked()` runs at boot only**, not on the 3s refresh. A dev server that dies on
  its own leaves a record for the daemon's lifetime — harmless now that `stop()` validates
  before killing.
- **Two unexplained single-run test failures** during the build-out, neither reproducible
  (8 and 17 consecutive clean runs after). Both occurred alongside concurrent daemon
  teardown. Suspected environment contention in tests that shell out to `lsof`/`git`/tmux.
  Not dismissed — unexplained.
- **Delete `public/`** once the SvelteKit UI has been used in anger. `WTS_UI=legacy` is the
  escape hatch until then. Note `test/crash.test.js` pins `WTS_UI=legacy` and will need a
  stub UI dir when `public/` goes.
