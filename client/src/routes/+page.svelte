<script>
  /*
   * The single screen. Work (rail + dock) and Fleet are two views of the same route,
   * not two routes — switching between them must not tear down the live terminal, and
   * a URL change would do exactly that on a static SPA fallback.
   *
   * Work is hidden rather than unmounted when Fleet is showing, for the same reason the
   * dock hides its terminal instead of unmounting it: reattaching a tmux pane costs a
   * full redraw, and the view toggle is a ⌘\ keystroke away.
   */
  import TopBar from '$lib/components/TopBar.svelte';
  import Rail from '$lib/components/rail/Rail.svelte';
  import Dock from '$lib/components/dock/Dock.svelte';
  import Fleet from '$lib/components/fleet/Fleet.svelte';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';

  const isFleet = $derived(ui.view === 'fleet');
</script>

<TopBar />

{#if world.streamError}
  <div class="streamwarn" role="status">{world.streamError}</div>
{/if}

<div class="main" hidden={isFleet}>
  <Rail />
  <Dock />
</div>

{#if isFleet}
  <Fleet />
{/if}

<style>
  .main { flex:1; display:grid; grid-template-columns: var(--rail-w) 1fr; min-height:0; }
  /* `hidden` on a grid container needs the !important from app.css to win; this keeps
     the flex child from claiming height while hidden. */
  .main[hidden] { flex:0; }
  .streamwarn { font-family:var(--mono); font-size:11px; color:var(--waiting); background:var(--waiting-bg); padding:5px 16px; flex:none; }
</style>
