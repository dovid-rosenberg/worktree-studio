<script lang="ts">
/*
 * Insights: ONE destination — a fleet overview you drill down from.
 *
 * There used to be two, sharing the word and the ◔ glyph: this fleet view, and a
 * session-scoped tab in the dock's tab strip (InsightsMount, now deleted). They
 * overlapped — `SessionUsage` rendered in both — and nothing on screen said which was
 * which, so "Insights" named two different places depending on where you clicked.
 *
 * The overview is the cost ranking; picking a row is the drill-down, and it happens
 * HERE rather than by navigating. It used to call `goToSession`, which resets dockView
 * to 'term' — so inspecting the second-biggest spender threw you out of the view you
 * were reading.
 *
 * Search does NOT live here. It was a section of the old session-scoped Insights tab,
 * and moving it into this drill-down buried it one level out instead of fixing it —
 * still something you reach only after arriving somewhere else for a different reason.
 * It is its own overlay now: ⌘⇧F, or "Search transcripts" in the palette and the ⋮ menu.
 * This view is cost and tokens, which is one subject.
 */
import UsagePanel from '$lib/components/insights/UsagePanel.svelte';
import { ui } from '$lib/stores/ui.svelte.js';

/*
 * Seeded from the store, then owned locally.
 *
 * `ui.insightsFocus` is what the caller asked to open on. A `$derived` would fight the
 * user — every row click would be overwritten by the seed on the next invalidation —
 * so it initialises the local value and nothing more.
 */
let picked = $state<string | null>(ui.insightsFocus);
</script>

<div class="fleetinsights">
  <UsagePanel sessionId={picked} onselect={(id: string) => (picked = id)} />
</div>

<style>
  /* One scroller for the whole view. */
  .fleetinsights { flex: 1; min-height: 0; overflow-y: auto; background: var(--bg); }
</style>
