<script lang="ts">
  /*
   * The single screen: rail | splitter | dock, with the action bar pinned underneath.
   *
   * There used to be two views here — Work and Fleet — swapped by a `hidden` attribute
   * rather than a route, because a URL change would tear down the live terminal on a
   * static SPA fallback. That constraint has not gone away; what changed is that Fleet is
   * no longer a peer of Work. Its content lives in the rail (feature-keyed, so sessionless
   * worktrees are visible) and in the dock's Overview pane, alongside Insights.
   *
   * The action bar spans the full width rather than sitting inside the dock: it acts on
   * the rail's selection, and anchoring it to the window means selecting something never
   * changes the geometry of anything above it.
   */
  import TopBar from '$lib/components/TopBar.svelte';
  import Rail from '$lib/components/rail/Rail.svelte';
  import RailSplitter from '$lib/components/rail/RailSplitter.svelte';
  import Dock from '$lib/components/dock/Dock.svelte';
  import ActionBar from '$lib/components/ActionBar.svelte';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';
</script>

<TopBar />

{#if world.streamError}
  <div class="streamwarn" role="status">{world.streamError}</div>
{/if}

<div class="main" style="--rail-w:{ui.railWidth}px">
  <Rail />
  <RailSplitter />
  <Dock />
</div>

<ActionBar />

<style>
  /* The splitter is a real column, so the rail's width is the only thing that moves. */
  .main { flex:1; display:grid; grid-template-columns: var(--rail-w) auto 1fr; min-height:0; min-width:0; }
  .streamwarn { font-family:var(--mono); font-size:12px; color:var(--waiting); background:var(--waiting-bg); padding:5px 16px; flex:none; }
</style>
