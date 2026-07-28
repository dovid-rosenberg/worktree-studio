# Unify Work + Fleet into one surface

Branch: `feature/unify-work-fleet`

Fleet stops being a view. Its content survives in two places: a **feature-keyed rail**
(so worktrees without a session stop being invisible) and an **Overview dock pane**
(so the wide terminal-free scan keeps full width).

## Decisions

**Filter semantics — a feature matches if ANY member repo matches, and renders whole.**
The alternative (show only matching members) would hide half of a BE+FE feature, which is
the exact grouping the identical-worktree-name convention exists to create.

**Sort order is load-bearing.** `Fleet.svelte:22` sorts active-first then A–Z so a feature
"does not jump around the list the moment its stack starts". The rail has no ordering at
all today (`Map` insertion order). This must be ported or the rail visibly reshuffles as
agents change state — a silent regression.

## Checklist

- [x] `ui.svelte.js` — feature-keyed rail model, sorting, member-aware filter, two-kind selection
- [x] `Rail.svelte` — four sections (servers running / main servers / agents / worktrees)
- [x] `rail/FeatureCard.svelte` — new: feature row w/ pills, slot, chips, quick actions, ⋯ menu
- [x] `rail/MainServerCard.svelte` — new: main-checkout dev server row
- [x] `rail/SessionCard.svelte` — unpromoted agent row, stopped variant w/ Resume
- [x] `dock/FeaturePane.svelte` — new: detail pane for a feature with no session
- [x] `Dock.svelte` — Overview pane + feature pane routing
- [x] `TopBar.svelte` — absorb Fleet's summary bar; Overview toggle keeps the waiting badge
- [x] `shortcuts.svelte.js` + `Palette.svelte` — ⌘\ toggles Overview
- [x] `+page.svelte` — single view, no Work/Fleet swap
- [x] Keep `fleet/*` mounted as the Overview pane (no rewrite, no loss)
- [x] `npm run typecheck` clean
- [x] `npm run build` clean
- [x] Verified in the running app

## Follow-up pass (same branch)

- [x] Rail cards carry NO buttons — hover-reveal removed, so rows never reflow under the
      pointer. Verified: card heights identical before/after hover.
- [x] `ActionBar.svelte` — full-width bottom bar, adapts to session vs feature selection.
      Absorbs everything the cards' hover actions and `⋯` menu held.
- [x] Scrollbars themed in both engines (`scrollbar-color` + `::-webkit-scrollbar-*`),
      tokens per theme. xterm excluded — it themes its own.
- [x] Pop out removed end-to-end: client op + both buttons, `POST /sessions/:id/popout`,
      `manager.popout`, `mux.popoutCommand`, `attachSpawn({popout})`, `config.popout`,
      the `types.ts` entry, and both test fixtures. The `kill-session … -popout` cleanup
      STAYS: sessions popped out before this change still need reaping.
- [x] `RailSplitter.svelte` — drag-resizable rail, 230–560px, persisted; pointer capture
      so a fast drag doesn't drop the handle; keyboard-resizable.
- [x] `FleetInsights.svelte` — Insights as an app-level view beside Overview, mounting the
      existing `UsagePanel` (fleet totals + feature/session breakdown). It was only ever
      reachable from the `/usage` dev harness. The dock's per-session Insights tab is
      unchanged.

### Splitter markup, for the record

`<button type="button" role="separator">`. svelte-check rejects BOTH alternatives — a
`<div>` "cannot have nonnegative tabIndex", a `<button>` "cannot have role 'separator'" —
so one suppression is unavoidable. The button is natively focusable and interactive (no
`tabindex`, no synthetic focus handling) and the role override keeps AT announcing a
divider with a width value, so the single `a11y_no_interactive_element_to_noninteractive_role`
ignore is the cheaper of the two.

## Preserved deliberately

- **Servers ⇄ Worktrees overlap.** A running feature appears in both sections.
  `ServerRow.svelte` says so outright: "when servers are running, this is the section you
  watch." Not duplication — do not clean up.
- `manual` tag on `config.groups` features; `working…` pending state; stopped-agent
  `↻ Resume` + dimming; `repo:port` labels in server contexts.
