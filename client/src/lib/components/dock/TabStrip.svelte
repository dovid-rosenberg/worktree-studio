<script>
  /*
   * The dock's tab strip: one tab per multiplexer window, plus the DOM panels that are
   * not tmux windows at all (✎ Changes, ▤ Logs, ◔ Insights), plus new-tab / pop-out /
   * split.
   *
   * The panel tabs are the mount points for the two panels other agents own — this
   * strip decides *when* they show; it knows nothing about what they render.
   */
  import { activatable } from '$lib/actions/activatable.js';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { addTab, closeTab, popout, selectTab } from '$lib/ops.svelte.js';

  let {
    session,
    /** Uncommitted-file count for the ✎ Changes badge; 0 hides it. */
    changesCount = 0,
  } = $props();

  const tabs = $derived(session.tabs && session.tabs.length ? session.tabs : [{ title: 'claude' }]);
  const promoted = $derived(!!session.worktreePath);
  const splitOn = $derived(ui.splitOn(session.id));

  let busyAdd = $state(false);
  let busyPop = $state(false);
</script>

<div class="tabstrip" role="tablist" aria-label="Session panels">
  {#each tabs as t, i (i)}
    {@const on = ui.dockView === 'term' && i === ui.activeTab}
    <span class="tab" class:on use:activatable={() => selectTab(session, i)} role="tab" aria-selected={on}>
      <span class="dot {on ? session.state : 'idle'}" title={on ? session.state : 'idle'}></span>
      {t.title}
      {#if tabs.length > 1}
        <span
          class="tabclose"
          title="Close tab"
          aria-label="Close tab"
          use:activatable={(e) => { e?.stopPropagation(); closeTab(session, i); }}
        >✕</span>
      {/if}
    </span>
  {/each}

  {#if promoted}
    <!-- ✎ Changes — the review panel's mount point. A DOM panel, not a tmux window. -->
    <span
      class="tab"
      class:on={ui.dockView === 'changes'}
      role="tab"
      aria-selected={ui.dockView === 'changes'}
      use:activatable={() => (ui.dockView = 'changes')}
    >
      ✎ Changes{#if changesCount}<span class="cbadge">{changesCount}</span>{/if}
    </span>

    <!-- ▤ Logs — live dev-server tail. -->
    <span
      class="tab"
      class:on={ui.dockView === 'logs'}
      role="tab"
      aria-selected={ui.dockView === 'logs'}
      use:activatable={() => (ui.dockView = 'logs')}
    >▤ Logs</span>
  {/if}

  <!-- ◔ Insights — the telemetry panel's mount point. Available for any session: a
       transcript exists before a worktree does. -->
  <span
    class="tab"
    class:on={ui.dockView === 'insights'}
    role="tab"
    aria-selected={ui.dockView === 'insights'}
    use:activatable={() => (ui.dockView = 'insights')}
  >◔ Insights</span>

  <span
    class="tab"
    aria-label="New tab"
    aria-disabled={busyAdd}
    use:activatable={async () => {
      if (busyAdd) return;
      busyAdd = true;
      try { await addTab(session); } finally { busyAdd = false; }
    }}
  ><span class="newtab">＋</span></span>

  <button
    class="btn xs popout"
    aria-label="Pop out"
    disabled={busyPop}
    onclick={async () => { busyPop = true; try { await popout(session); } finally { busyPop = false; } }}
  >Pop out ⧉</button>

  <!-- ⊟ Split — a second live terminal beside the primary. Only meaningful in the term
       view, so it only appears there (as in app.js). -->
  {#if ui.dockView === 'term'}
    <button
      class="btn xs split-toggle"
      class:on={splitOn}
      aria-pressed={splitOn}
      title="Open an independent working shell in this worktree, beside the Claude terminal"
      onclick={() => ui.toggleSplit(session.id)}
    >⊟ Split</button>
  {/if}
</div>

<style>
  .tabstrip { display:flex; align-items:center; gap:3px; padding:8px 12px 0; background:var(--elevated); border-bottom:1px solid var(--border); flex:none; flex-wrap:wrap; }
  .tab { font-family:var(--mono); font-size:11.5px; color:var(--muted); padding:6px 12px; border-radius:7px 7px 0 0; display:flex; align-items:center; gap:7px; border:1px solid transparent; border-bottom:none; cursor:pointer; }
  .tab.on { color:var(--ink); background:var(--bg); border-color:var(--border); }
  .tab .newtab { color:var(--faint); }
  .cbadge { font-family:var(--mono); font-size:9.5px; font-weight:700; background:var(--brand); color:var(--brand-ink); border-radius:999px; padding:0 5px; min-width:15px; text-align:center; }
  .tabclose { color:var(--faint); margin-left:2px; font-size:10px; padding:0 2px; border-radius:3px; }
  .tabclose:hover { color:var(--ink); background:var(--border); }
  .popout { margin-left:auto; }
  .split-toggle { margin-left:6px; }
  .split-toggle.on { border-color:var(--brand); color:var(--brand); }
</style>
