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
   * `SearchPanel` comes with the drill-down. It is app-level transcript search that was
   * only ever reachable through the session tab, which is why it locks its own scope
   * picker: it was buried inside the thing it was scoped to. It appears when a session is
   * picked, which is the moment its scope means anything.
   */
  import UsagePanel from '$lib/components/insights/UsagePanel.svelte';
  import SearchPanel from '$lib/components/insights/SearchPanel.svelte';
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

  {#if picked}
    <!-- Keyed so switching rows starts the panel over rather than leaving the previous
         session's query and results on screen. -->
    {#key picked}
      <div class="search-block">
        <!-- autofocus={false}: this appeared because a row was clicked, not because a
             modal opened over the user — stealing the caret would fight that click. -->
        <SearchPanel sessionId={picked} autofocus={false} />
      </div>
    {/key}
  {/if}
</div>

<style>
  /* One scroller for the whole view. The overview is short and the search results are the
     part that grows; nesting scrollers produces the classic "scrolled the wrong pane"
     problem. */
  .fleetinsights { flex: 1; min-height: 0; overflow-y: auto; background: var(--bg); }
  .search-block { border-top: 1px solid var(--border); display: flex; flex-direction: column; }
</style>
