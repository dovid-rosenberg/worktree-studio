<script lang="ts">
  /*
   * The application header: brand, the Insights toggle (carrying the waiting-count
   * attention badge), and the ⋮ menu. Three things.
   *
   * It used to carry eleven: Insights, four counts, Restart all, Stop all, ⌘K, ⚙, ◐ and
   * + New session — a dense band of competing weight above the content you are actually
   * reading, with no ordering principle among them.
   *
   * Where the rest went, and why:
   *   + New session  → the head of the rail. It creates the thing the rail lists, so it
   *                    belongs at the top of that list, not across the app from it.
   *   the counts     → the rail footer, beside the rows they count.
   *   Restart / Stop all, ⌘K, ⚙, ◐ → the ⋮ menu. Rare, or fleet-wide and destructive.
   *
   * What stays is the one thing you watch (the waiting badge) and one way in to the rest.
   */
  import AppMenu from '$lib/components/AppMenu.svelte';
  import { world } from '$lib/stores/world.svelte.js';
  import { uiConfirm } from '$lib/stores/dialog.svelte.js';
  import { ui, featureActive, liveMembers } from '$lib/stores/ui.svelte.js';
  import { notify } from '$lib/stores/notify.svelte.js';
  import { restartStack, stopStack } from '$lib/ops.svelte.js';

  const feats = $derived(world.features);
  /*
   * Fleet-wide and irreversible, so it asks — as every other destructive verb in
   * ops.svelte.ts already does (closeSession, deleteFeature, closeFeature,
   * deactivateSession all go through uiConfirm). This one fired on a single click, from a
   * 32px menu row directly below "Restart all servers", so a mis-aimed click killed every
   * dev server running anywhere.
   */
  async function stopAllServers() {
    const feats = runningFeats();
    if (!feats.length) return;
    const ok = await uiConfirm(
      `Stop the dev servers of all ${feats.length} running feature(s): ${feats.map((f) => f.name).join(', ')}?`,
      { title: 'Stop all servers', okLabel: 'Stop all', danger: true },
    );
    if (ok) for (const f of feats) stopStack(f.name);
  }

  const runningFeats = () => feats.filter((f) => liveMembers(f).some((m) => m.running));
  const anyRunning = $derived(feats.some(featureActive));
</script>

<header class="topbar">
  <div class="brand"><span class="glyph">⎇</span> Worktree&nbsp;Studio</div>

  <span class="spacer"></span>

  <!-- Its own button, appearing only when something IS waiting.
       This used to be a badge on Insights, so the one state worth interrupting you for
       took you to the usage breakdown — away from the session asking for you, and (before
       openInsights learned to put it back) at the cost of your selection. A count is the
       question; this button is the answer, so pressing it goes to the next waiting agent. -->
  {#if notify.waitingCount}
    <button
      class="btn ghost ovbtn attn"
      data-n={notify.waitingCount}
      title="{notify.waitingCount} session(s) waiting for you — go to the next"
      onclick={() => ui.goToNextWaiting()}
    >◉ Waiting</button>
  {/if}

  <button
    class="btn ghost ovbtn"
    class:on={ui.dockView === 'usage'}
    aria-pressed={ui.dockView === 'usage'}
    title="Insights (⌘\\)"
    onclick={() => ui.toggleUsage()}
  >◔ Insights</button>

  <AppMenu
    {anyRunning}
    onrestartall={() => runningFeats().forEach((f) => restartStack(f.name))}
    onstopall={stopAllServers}
  />
</header>

<style>
  .topbar { display:flex; align-items:center; gap:12px; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--panel); flex:none; }
  .brand { font-weight:700; font-size:17px; letter-spacing:-.01em; display:flex; align-items:center; gap:7px; }
  .brand .glyph { color:var(--brand); font-size:19px; }
  .spacer { flex:1; }

  .ovbtn { font-weight:600; }
  .ovbtn.on { background:var(--brand); border-color:var(--brand); color:var(--brand-ink); }

  /* Attention badge: the number of sessions currently waiting. */
  .attn { position:relative; }
  .attn::after { content:attr(data-n); position:absolute; top:-6px; right:-6px; min-width:17px; height:17px; padding:0 4px; background:var(--waiting); color:#241a06; font-family:var(--mono); font-size:11px; font-weight:700; border-radius:999px; display:grid; place-items:center; box-shadow:0 0 0 2px var(--panel); }
  .attn[data-n="0"]::after, .attn:not([data-n])::after { display:none; }
</style>
