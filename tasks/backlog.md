# Backlog — everything open, in priority order

Written 2026-07-28. Supersedes the scattered "open" markers in `v3-plan.md` §1–§3;
that file keeps the *reasoning* behind each item, this one is the queue.

Ordering is by payoff-per-effort for the actual workflow (many agents, many repos,
watched at a glance), not by area.

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

## P0 — the rail lies about what is happening

### 1. One row per thing
`Rail.svelte` renders a feature under `⇅ Servers running` AND again under `⎇ Worktrees`.
`fleet/ServerRow.svelte` argued the overlap was deliberate ("when servers are running,
this is the section you watch"). **David has settled it: no duplication.** Delete the
running-servers section; sort running features to the top of one list.

### 2. Rename the bottom section, and widen what it holds
"Worktrees" names the implementation, not the thing. It should be **everything not
running** — including sessions that have no worktree yet, which today sit in a separate
`✦ Agents · no worktree` section.

> **The review pushed back on the label, not the instinct.** "Running" is two orthogonal
> things here — dev servers up, and agent state — and `featureActive` already conflates
> them. A bucket called "not running" puts a **waiting agent that needs your answer** in
> with a stale worktree from last month. Counter-proposal: **one flat list, no sections**,
> sorted active-first, with a single hairline divider (`idle · 4`) where the active run
> ends. Sessionless agents and main-checkout servers become cards in that list with a
> type glyph, not their own headers. Same "everything else at the bottom", without a
> taxonomy that buries the one row that wants you.
>
> Side effect it also fixes: four `.sectionrow`s all set `position:sticky; top:0` in one
> scroller, so they collide while scrolling.

### 3. Status indicators — it is six, not three
A card can show: a state dot, an `agent · <state>` pill **with its own dot** encoding the
same value eight pixels away, a `⇅ servers` pill, a per-member dot per repo, a `✓ merged`
badge, a slot badge, and a green left border. At 7 cards that is ~42 glyphs to scan to
find one waiting agent. Nothing says which is which.

Review's recommendation, which I'd adopt: **one dot = agent state, one green left edge =
servers up, nothing else by default.** Plus a legend in the `?` sheet.
- Render a pill only when its state is **non-default** (`v3-plan` §1.3): absence means
  stopped/idle, so `agent · waiting` stops competing with six neighbours.
- Give the survivors distinguishable form, not just colour.

### 4. Buttons exist in two places — with one carve-out
`DockHead` (top) and `ActionBar` (bottom) both carry Delete, Deactivate, Open in editor,
＋repo, Rename. **All of it moves to the bottom.** DockHead keeps identity only —
title, branch, state.

> **Carve-out from the review, which I agree with:** do NOT move `TabStrip`'s controls
> down. `＋`, `⊟ Split` and Changes/Logs/Insights are *view switchers*, not actions on the
> selection. The learnable law is **top switches what you are looking at, bottom does
> something to it** — "everything at the bottom" would put tab switching 900px from the
> tabs.

---

## P1 — things that are the wrong shape

### 5. Delete the Overview view — confirmed redundant
`Fleet.svelte` mounted as a dock pane. Once the rail is fixed (1–3) it shows the same
information in a second place, which is the problem it was meant to solve. Removing it
also retires `ui.dockView === 'overview'`, the `⌘\` toggle, the TopBar button, and the
six `fleet/*` components — a parallel component tree that will otherwise drift from the
rail cards. **Check `fleet/FeatureMenu` for verbs the ActionBar lacks before deleting.**

### 6. Insights becomes a pure info view — and it already loses history

> **The review found the data bug behind this.** `server/transcript-routes.ts` builds the
> usage response by iterating `manager.all()` — *live* sessions — and looks up index rows
> per live session. `transcript-index.ts` never deletes rows. So a deleted session's cost
> data is on disk and unreachable: exactly the "insights on past work" you asked for.
> Fix is cheap — iterate the index as the outer loop and render sessions with no live
> counterpart as archived rows.
- It must not link back into selecting a session (`FleetInsights` currently wires
  `onselect` → `ui.goToSession`).
- Opening it should **deselect everything** — it is about the fleet, not the selection.
- It must survive the worktree being gone. Telemetry comes from transcripts, which
  outlive the worktree; the view should say so rather than depend on live session rows.

### 7. Splits
- Closing the split's last tab should close the **split**. Today `SplitPane` can close
  its tabs but only `ui.toggleSplit()` closes the pane, so you can empty it and be left
  with an empty half.
- The split's tab strip renders as a second row of tabs below the main one, because the
  split is a separate tmux session with its own windows. Decide: fold them into one
  strip (visually one thing, two owners) or make the separation deliberate and labelled.

### 8. `FeaturePane` — cut half of it, keep the other half
Its `.cta` button row is a 1:1 duplicate of ActionBar's feature branch — delete that.
The **table is not duplicated**: it is the only place branch, ports, merge state and
per-repo server state appear together, which is the thing to check on a BE+FE feature.
Keep the table, kill the buttons, and give the reclaimed space to what is actually
missing: recent commits + uncommitted count per member repo (the `/api/sessions/:id/commits`
machinery already exists), so a sessionless worktree can answer "what is in here, and is
it merged?" without starting an agent.

---

## P2 — noise and wording

### 9. Drop `mux: tmux` from the TopBar
tmux is the only driver. It was a badge when zellij was still a possibility.

### 10. `reattached` is jargon, and stale — set `activity = ''` instead
Set once in `sessions.ts` `restore()` when a tmux session outlived a daemon restart —
"I reconnected instead of relaunching". It then never updates until the next hook, so it
sits on every card forever. Either drop boot-time activity strings entirely, or word it
for a reader: *"resumed — tmux session was still running"*.

### 11. Terminal background should follow the theme
`theme.svelte.ts` already has `TERM_THEMES` with a light entry, and `Terminal.svelte`
calls `termTheme()`. Both light and dark values are currently *dark* (`#0c0f14` /
`#12151b`) by an old deliberate choice — "a light-on-white terminal reads as a different
app". David wants it to actually change. Pick a real light palette.

### 12. Summary-bar arithmetic (`v3-plan` §1.2)
`running` counts servers; `working`/`waiting` count agents. Presented as one comma-run
they read as parts of one total that does not add up. Split the vocabularies, hide zeros.

### 13. Verb vocabularies (`v3-plan` §1.4)
`Stop stack` vs `Stop`, `Run stack` vs `Start session`. Green means both "is running"
(state) and "start this" (action). One verb per concept; colour means state only.

---

## P3 — testing, and the things that only bite later

### 14. Client tests: still zero
No vitest, no testing-library, no playwright. Every UI bug in this project's history —
two broken auth layers, placeholder dock mounts, the terminal reopening its WebSocket
every frame, the tab mislabeling — was found by manually driving a browser, and none of
it is repeatable. **Highest-value engineering gap in the repo.** Start with
`stores/world.svelte.ts` (the SSE stitching has had a real bug) and rail rendering.

### 15. End-to-end coverage is server-only (`v3-plan` §2.2–2.5)
Two e2e tests, no property tests where they are obviously right (hunk math, feature
identity), no smoke suite, chaos testing only ad hoc.

### 15a. Unmentioned, from the review
- **Rail header lies**: titled `Features`, but the list holds agents and main-checkout
  servers; the footer counts `feats.length` "feature(s)" while excluding them. Retitle to
  `Work`, count what is drawn.
- **`TabStrip` writes `ui.dockView` directly** rather than `setDockView`, bypassing the
  persistence logic. Harmless today, a trap later.
- **The two-field selection model should collapse** into one tagged value
  (`{ kind: 'session' | 'feature', id }`). The `startFeatureSession` bug fixed above was
  this model failing exactly where its own comment promised it would not.

### 16. Deferred, from `v3-plan` §3
- `/group/pr` loops members serially; a wedged member delays its siblings.
- `pruneTracked()` runs at boot only, so a dev server that dies on its own leaves a
  record for the daemon's lifetime.
- Two unexplained single-run test failures during the v2 build-out, never reproduced.
  Suspected environment contention around `lsof`/git/tmux. Not dismissed.

---

## Not scheduled — decided against

- **Restoring `public/`, `WTS_UI`, the dev-harness routes or `bin/vendor.ts`.** Removed
  2026-07-28; the client is the only UI.
- **Pop-out.** Removed; tmux attach from a terminal does the same job without the app
  owning a second window.
