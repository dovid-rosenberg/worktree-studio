# Backlog — everything open, in priority order

Written 2026-07-28. Supersedes the scattered "open" markers in `v3-plan.md` §1–§3;
that file keeps the *reasoning* behind each item, this one is the queue.

Ordering is by payoff-per-effort for the actual workflow (many agents, many repos,
watched at a glance), not by area.

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
`✦ Agents · no worktree` section. Two sections total: what is running, and what is not.

### 3. Three status indicators, none legible
A card can show a state dot, an `agent · <state>` pill, a `servers · <state>` pill, a
slot badge and a merged badge. Nothing says which is which.
- Render a pill only when its state is **non-default** (`v3-plan` §1.3): absence means
  stopped/idle, so `agent · waiting` stops competing with six neighbours.
- Give the survivors distinguishable form, not just colour.

### 4. Buttons exist in two places
`DockHead` (top) and `ActionBar` (bottom) both carry Delete, Deactivate, Open in editor,
＋repo, Rename. **All of it moves to the bottom.** DockHead keeps identity only —
title, branch, state — or goes away entirely.

---

## P1 — things that are the wrong shape

### 5. Delete the Overview view
`Fleet.svelte` mounted as a dock pane. Once the rail is fixed (1–3) it shows the same
information in a second place, which is the problem it was meant to solve. Removing it
also retires `ui.dockView === 'overview'`, the `⌘\` toggle and the TopBar button.

### 6. Insights becomes a pure info view
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

### 8. `FeaturePane` — replace, don't keep
It shows a repo/branch/port table where the terminal would be, for a feature with no
session. The ActionBar already carries every action it offers. Candidates for that
space: recent commits on the branch, the diff vs base, or the last transcript for that
feature — something you cannot get from the bottom bar.

---

## P2 — noise and wording

### 9. Drop `mux: tmux` from the TopBar
tmux is the only driver. It was a badge when zellij was still a possibility.

### 10. `reattached` is jargon, and stale
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
