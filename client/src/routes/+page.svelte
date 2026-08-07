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
  import { ui } from '$lib/stores/ui.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';
  import { hashForSelection, selectionFromHash } from '$lib/deeplink.js';
  import { onMount } from 'svelte';

  /*
   * Deep links, both directions.
   *
   * Reading once at load is not enough: when Alfred or the menubar opens the cockpit's
   * URL and a tab is already on it, the browser focuses that tab and only changes the
   * fragment — no reload, no mount. Without the `hashchange` listener the second link
   * you follow would appear to do nothing.
   *
   * Writing keeps the URL honest as you navigate, so the address bar is always a link
   * to what you are looking at. `replaceState` rather than a hash assignment: assigning
   * `location.hash` pushes a history entry per click, turning Back into an undo of your
   * last twenty selections. It also does not re-enter the listener above, which an
   * assignment would.
   */
  onMount(() => {
    const fromUrl = () => {
      const s = selectionFromHash(window.location.hash);
      if (s) ui.applySelection(s);
    };
    fromUrl();
    window.addEventListener('hashchange', fromUrl);
    return () => window.removeEventListener('hashchange', fromUrl);
  });

  $effect(() => {
    const want = hashForSelection(ui.selection);
    // Nothing selected leaves the existing fragment alone rather than rewriting the URL
    // on the way to a blank one — the app clears the selection during ordinary work.
    if (!want || want === window.location.hash) return;
    window.history.replaceState(null, '', want);
  });
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

<style>
  /* The splitter is a real column, so the rail's width is the only thing that moves. */
  .main { flex:1; display:grid; grid-template-columns: var(--rail-w) auto 1fr; min-height:0; min-width:0; }
  .streamwarn { font-family:var(--mono); font-size:12px; color:var(--waiting); background:var(--waiting-bg); padding:5px 16px; flex:none; }
</style>
