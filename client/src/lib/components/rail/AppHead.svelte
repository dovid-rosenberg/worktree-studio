<script lang="ts">
  /*
   * The application header: brand, the waiting button, the Insights toggle and the ⋮
   * menu. Four things, and every one of them is about the WHOLE FLEET.
   *
   * IT SITS AT THE HEAD OF THE RAIL, not across the top of the window. That is the point:
   * the rail is the fleet and the dock is one feature, so the split by scope is already
   * drawn down the middle of the screen and these controls belong on the rail's side of
   * it. As a full-width band it was a third horizontal stripe — app bar, then the dock's
   * feature bar, then the tab strip — before any content, and it put fleet-wide verbs
   * directly above a bar that acts on one selection, with nothing but a divider to say
   * which was which.
   *
   * The cost of the move is width: a 212px column has no room for `⎇ Worktree Studio` at
   * 17px beside three buttons, so the wordmark shortens and the two toggles become their
   * glyphs, named by `aria-label` and `title`.
   *
   * It used to carry eleven controls: Insights, four counts, Restart all, Stop all, ⌘K,
   * ⚙, ◐ and + New session. Where the rest went, and why:
   *   + New session  → directly below, at the head of the rail. It creates the thing the
   *                    rail lists.
   *   the counts     → the rail footer, beside the rows they count.
   *   Restart / Stop all, ⌘K, ⚙, ◐ → the ⋮ menu. Rare, or fleet-wide and destructive.
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

<header class="apphead">
  <!--
    The ROOT SWITCHER, or the wordmark when there is nothing to switch between.

    Only ever one of the two: a picker offering a single choice is a control that cannot
    do anything, and it would be sitting in the most valuable 120px in the app. With two
    or more roots the switcher takes the wordmark's place rather than crowding in beside
    it — you know what app you are in; you do not always know which body of work you are
    looking at, and that is the thing worth naming here.

    A native <select>, deliberately, matching the rail's repo and sort pickers directly
    below it. This is the same kind of act as those two — it changes what the list shows
    and nothing about the work — so it should not look like a heavier one.
  -->
  {#if ui.roots.length > 1}
    <select
      class="rootpick"
      value={ui.rootFilter}
      onchange={(e) => ui.setRoot(e.currentTarget.value)}
      title="Which root folder to work in"
      aria-label="Root folder"
    >
      <option value="">All roots · {ui.rootTotal} repos</option>
      {#each ui.roots as r (r.path)}
        <option value={r.path} title={r.path}>{r.label} · {r.repos} repos</option>
      {/each}
    </select>
  {:else}
    <div class="brand" title="Worktree Studio"><span class="glyph">⎇</span> Studio</div>
  {/if}

  <span class="spacer"></span>

  <!-- Its own button, appearing only when something IS waiting.
       This used to be a badge on Insights, so the one state worth interrupting you for
       took you to the usage breakdown — away from the session asking for you, and (before
       openInsights learned to put it back) at the cost of your selection. A count is the
       question; this button is the answer, so pressing it goes to the next waiting agent.

       The count IS the label here rather than a badge pinned to the word "Waiting": in a
       212px column the word costs more than it says, and the badge it carried was a
       second copy of the same number. -->
  {#if notify.waitingCount}
    <button
      class="btn ghost ovbtn attn"
      aria-label="{notify.waitingCount} session(s) waiting — go to the next"
      title="{notify.waitingCount} session(s) waiting for you — go to the next"
      onclick={() => ui.goToNextWaiting()}
    >◉ {notify.waitingCount}</button>
  {/if}

  <button
    class="btn ghost ovbtn"
    class:on={ui.dockView === 'usage'}
    aria-pressed={ui.dockView === 'usage'}
    aria-label="Insights"
    title="Insights (⌘\\)"
    onclick={() => ui.toggleUsage()}
  >◔</button>

  <AppMenu
    {anyRunning}
    onrestartall={() => runningFeats().forEach((f) => restartStack(f.name))}
    onstopall={stopAllServers}
  />
</header>

<style>
  /* Reads as the rail's head, not as a bar: same panel ground and bottom rule as the
     filter row below it, tighter padding than a window-wide header could afford. */
  .apphead { display:flex; align-items:center; gap:6px; padding:9px 10px 9px 14px;
             border-bottom:1px solid var(--border); background:var(--panel); flex:none; }
  .brand { font-weight:700; font-size:13.5px; letter-spacing:-.01em; display:flex; align-items:center; gap:6px; white-space:nowrap; }
  .brand .glyph { color:var(--brand); font-size:15px; }

  /* Weighted like the wordmark it replaces, because it is doing that job: it names where
     you are. `min-width:0` so a long root name truncates instead of pushing the three
     buttons out of a 212px column. */
  .rootpick {
    font-family:inherit; font-size:13px; font-weight:650; color:var(--ink);
    background:transparent; border:1px solid transparent; border-radius:7px;
    padding:3px 4px; min-width:0; max-width:100%; cursor:pointer;
  }
  .rootpick:hover { border-color:var(--border); background:var(--elevated); }
  .spacer { flex:1; }

  /* Square-ish, so three of them fit beside the wordmark at the narrowest rail width. */
  .ovbtn { font-weight:600; padding:4px 8px; }
  .ovbtn.on { background:var(--brand); border-color:var(--brand); color:var(--brand-ink); }
  /* The one control here that is about an interruption, so it is the one that is
     coloured. Not a fill: it would outweigh ＋ New session directly beneath it. */
  .attn { color:var(--waiting); }
</style>
