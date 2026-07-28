<script lang="ts">
  import type { Session } from '../../../../../server/types';
  /*
   * The Insights panel — transcript search + cost/token telemetry — mounted in the dock.
   *
   * There is no single `Insights.svelte`; the insights branch built two independent
   * surfaces (`SessionUsage` and `SearchPanel`), each usable on its own. Composing them
   * is this file's job, and doing it here keeps the shell ignorant of that shape.
   *
   * Contract the dock guarantees:
   *  - Rendered only while `ui.dockView === 'insights'`, for ANY session — a transcript
   *    exists before a worktree does, so this tab is not gated on promotion.
   *  - `session` is the live, stitched session object.
   *  - The panel owns the full remaining height of the dock, above the server bar.
   *
   * Both children are scoped to this session: `SessionUsage` fetches its own usage from
   * `sessionId`, and `SearchPanel` locks its scope picker to it. `autofocus={false}` —
   * this is a tab the user switched to, not a modal that opened over them, so stealing
   * the caret would fight the terminal for keyboard focus.
   *
   * `{#key sessionId}` for the same reason as ReviewMount: `session` is a new object on
   * every `session-state` frame, so keying the object would remount (and re-fetch, and
   * clear the query) several times a second. Keying the id remounts only on a real switch.
   */
  import SessionUsage from '$lib/components/insights/SessionUsage.svelte';
  import SearchPanel from '$lib/components/insights/SearchPanel.svelte';

    let { session }: { session?: Session } = $props();

  const sessionId = $derived(session?.id ?? null);
</script>

{#if sessionId}
  {#key sessionId}
    <div class="insights-mount">
      <div class="usage-block">
        <SessionUsage {sessionId} />
      </div>
      <div class="search-block">
        <SearchPanel {sessionId} autofocus={false} />
      </div>
    </div>
  {/key}
{/if}

<style>
  /* One scroller for the pair rather than two nested ones: the usage block is short and
     fixed-height, the search results are the part that grows, and nesting scrollers here
     produces the classic "scrolled the wrong pane" problem. */
  .insights-mount {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    background: var(--bg);
    display: flex;
    flex-direction: column;
  }
  .usage-block { flex: 0 0 auto; border-bottom: 1px solid var(--border); }
  .search-block { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
</style>
