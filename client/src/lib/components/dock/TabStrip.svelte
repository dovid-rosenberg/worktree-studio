<script lang="ts">
  /*
   * The dock's tab strip.
   *
   * TWO GROUPS, deliberately not one row of look-alikes. The left group is terminal
   * tabs: real multiplexer windows, each a live process you can rename and close. The
   * right group is DOM panels (Changes / Logs / Insights) — views of the same session
   * that own no process and cannot be closed. They used to sit in a single undifferentiated
   * `role="tablist"`, so a ✕ on one meant "kill a shell" and on the next meant nothing,
   * and `＋`/`⊟ Split` were non-tab children of a tablist, which is invalid ARIA.
   *
   * TABS ARE ADDRESSED BY WINDOW ID, never by position. tmux runs with
   * `renumber-windows on`: closing a window renumbers every later one, so an index held
   * across a close names a different terminal. The `{#each}` is keyed on the id for the
   * same reason — keyed by position, closing a middle tab made Svelte reuse the DOM node
   * of one tab for the contents of another, carrying focus and the close handler with it.
   *
   * Keyboard: the group is one tab stop with a roving tabindex (←/→, Home/End), which is
   * the tablist pattern. Previously every tab was its own tab stop, so Tab walked through
   * all of them before reaching the terminal.
   */
  import { ui } from '$lib/stores/ui.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';
  import { addTab, closeTab, renameTab, selectTab } from '$lib/ops.svelte.js';
  import type { Session, SessionTab } from '../../../../../server/types';

  let {
    session,
    /** Uncommitted-file count for the ✎ Changes badge; 0 hides it. */
    changesCount = 0,
  }: { session: Session; changesCount?: number } = $props();

  const tabs = $derived<SessionTab[]>(
    session.tabs && session.tabs.length ? session.tabs : [{ id: '0', title: 'claude' }],
  );
  const promoted = $derived(!!session.worktreePath);

  /** Every run belonging to a worktree this session owns — see RunsPanel. */
  const myRuns = $derived.by(() => {
    const paths = new Set(
      [session.worktreePath, ...(session.repos || []).map((r) => r.worktreePath)].filter(Boolean),
    );
    return (world.view.runs || []).filter((r) => paths.has(r.worktreePath));
  });

  const activeRuns = $derived(myRuns.filter((r) => r.status === 'running').length);

  /*
   * What the Runs tab says when nothing is running.
   *
   * A count that vanishes the moment a run ends tells you a test suite finished but not
   * whether it PASSED — which is the only thing you wanted to know, and would send you
   * into the panel to find out. So the badge outlives the run: it carries the newest
   * finished run's outcome until something else runs.
   *
   * Only a failure is worth a mark. A green badge on every tab forever is noise, and
   * "nothing is shouting" already reads as fine.
   */
  const lastFailed = $derived(
    activeRuns === 0 && myRuns.find((r) => r.status !== 'running')?.status === 'failed',
  );

  /**
   * Which tab the MULTIPLEXER has selected. tmux owns this, and it is what the terminal
   * is actually showing.
   */
  const muxActive = $derived(tabs.find((t) => t.active)?.id ?? '');

  /**
   * The selected tab, resolved against tabs that actually exist. If the stored id is
   * gone — closed here, or killed in tmux directly — fall back to whatever the
   * multiplexer says, then to the first tab, rather than highlighting nothing while a
   * pane is still on screen.
   */
  const activeId = $derived(
    tabs.some((t) => t.id === ui.activeTabId)
      ? ui.activeTabId
      : (muxActive || tabs[0]?.id || ''),
  );

  /*
   * FOLLOW THE MULTIPLEXER.
   *
   * `ui.activeTabId` is a local intent — set optimistically on click so the highlight
   * moves before the round-trip. But tmux changes the current window for reasons the
   * client never initiated: `new-window` selects what it creates, so the ＋ button, a run
   * configuration, and anything typed into tmux directly all move it. Nothing reconciled
   * the two, so the strip kept pointing at the tab you were on while the terminal showed
   * the new one — reported twice, from two different features, because it was never one
   * feature's bug.
   *
   * Mirroring on CHANGE, not on every frame: a click sets `activeTabId` and posts
   * select-tab, the server answers with the same value, and this sees no change. Only a
   * selection the client did not make moves it.
   */
  let lastMuxActive = $state('');
  $effect(() => {
    const next = muxActive;
    if (!next || next === lastMuxActive) return;
    lastMuxActive = next;
    if (ui.activeTabId !== next) ui.activeTabId = next;
  });

  let renaming = $state<string | null>(null);
  let draft = $state('');
  let strip = $state<HTMLElement | null>(null);

  function beginRename(t: SessionTab) {
    renaming = t.id;
    draft = t.title;
  }

  async function commitRename(t: SessionTab) {
    const next = draft.trim();
    renaming = null;
    if (next && next !== t.title) await renameTab(session, t.id, next);
  }

  /**
   * Roving focus across the terminal tabs — the tablist keyboard contract.
   *
   * Bound to each TAB, not to the tablist container: with a roving tabindex the focus
   * is always on a tab, so that is where the key arrives. Putting it on the container
   * would mean giving the container a tabindex it has no business having.
   */
  function onTabKeydown(e: KeyboardEvent, tab: SessionTab) {
    if (e.key === 'F2') { e.preventDefault(); beginRename(tab); return; }
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === activeId);
    const last = tabs.length - 1;
    const to = e.key === 'ArrowLeft' ? Math.max(0, i - 1)
      : e.key === 'ArrowRight' ? Math.min(last, i + 1)
      : e.key === 'Home' ? 0 : last;
    const t = tabs[to];
    if (t) {
      selectTab(session, t.id);
      queueMicrotask(() => strip?.querySelector<HTMLElement>(`[data-tab="${t.id}"]`)?.focus());
    }
  }

  /** Middle-click closes, as it does in every terminal and browser. */
  function onAuxClick(e: MouseEvent, t: SessionTab) {
    if (e.button !== 1 || tabs.length <= 1) return;
    e.preventDefault();
    closeTab(session, t.id);
  }
</script>

<div class="tabstrip">
  <!-- ── terminal tabs: one live multiplexer window each ─────────────────── -->
  <div class="group terms" role="tablist" aria-label="Terminal tabs" bind:this={strip}>
    {#each tabs as t (t.id)}
      {@const on = ui.dockView === 'term' && t.id === activeId}
      {#if renaming === t.id}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="tab renaming"
          bind:value={draft}
          autofocus
          aria-label="Rename tab"
          onblur={() => commitRename(t)}
          onkeydown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitRename(t); }
            else if (e.key === 'Escape') { e.preventDefault(); renaming = null; }
          }}
        />
      {:else}
        <button
          type="button"
          class="tab"
          class:on
          role="tab"
          aria-selected={on}
          data-tab={t.id}
          tabindex={t.id === activeId ? 0 : -1}
          title="{t.title} — double-click to rename"
          onclick={() => selectTab(session, t.id)}
          ondblclick={() => beginRename(t)}
          onauxclick={(e) => onAuxClick(e, t)}
          onkeydown={(e) => onTabKeydown(e, t)}
        >
          <span class="dot {on ? session.state : 'idle'}" title={on ? session.state : 'idle'}></span>
          <span class="label">{t.title}</span>
          {#if tabs.length > 1}
            <!-- A real button, so it is reachable and announced; stopPropagation keeps
                 the click off the tab underneath it. -->
            <span
              class="tabclose"
              role="button"
              tabindex="-1"
              title="Close {t.title}"
              aria-label="Close tab {t.title}"
              onclick={(e) => { e.stopPropagation(); closeTab(session, t.id); }}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); closeTab(session, t.id); } }}
            >✕</span>
          {/if}
        </button>
      {/if}
    {/each}

  </div>

  <!-- Outside the tablist on purpose: a tablist's children must all be tabs, and this
       creates one rather than being one. -->
  <button type="button" class="tab add" title="New shell tab" aria-label="New shell tab" onclick={() => addTab(session)}>＋</button>

  <span class="spring"></span>

  <!-- ── panels: views of this session, no process, nothing to close ──────── -->
  <div class="group panels" role="tablist" aria-label="Session panels">
    {#if promoted}
      <button
        type="button" class="pill-tab" class:on={ui.dockView === 'changes'} role="tab"
        aria-selected={ui.dockView === 'changes'} onclick={() => (ui.dockView = 'changes')}
      >✎ Changes{#if changesCount}<span class="cbadge">{changesCount}</span>{/if}</button>

      <button
        type="button" class="pill-tab" class:on={ui.dockView === 'logs'} role="tab"
        aria-selected={ui.dockView === 'logs'} onclick={() => (ui.dockView = 'logs')}
      >▤ Logs</button>

      <!-- Running → a live count. Nothing running but the last one failed → a mark that
           stays, because "it finished" is not the answer you were waiting for. -->
      <button
        type="button" class="pill-tab" class:on={ui.dockView === 'runs'} role="tab"
        aria-selected={ui.dockView === 'runs'} onclick={() => (ui.dockView = 'runs')}
        title={activeRuns
          ? `${activeRuns} run(s) in progress`
          : lastFailed
            ? 'The last run failed'
            : 'Tests, builds and other one-off commands'}
      >▶ Runs{#if activeRuns}<span class="cbadge live">{activeRuns}</span>{:else if lastFailed}<span class="cbadge bad">!</span>{/if}</button>
    {/if}

    <!-- Available for any session: a transcript exists before a worktree does. -->
  </div>
</div>

<style>
  .tabstrip { display:flex; align-items:flex-end; gap:8px; padding:8px 12px 0; background:var(--elevated); border-bottom:1px solid var(--border); flex:none; flex-wrap:wrap; }
  .group { display:flex; align-items:flex-end; gap:3px; min-width:0; }
  .spring { flex:1; }

  .tab {
    font-family:var(--mono); font-size:12.5px; color:var(--muted); padding:6px 10px;
    border-radius:7px 7px 0 0; display:flex; align-items:center; gap:7px;
    border:1px solid transparent; border-bottom:none; cursor:pointer;
    background:none; max-width:190px; min-width:0;
  }
  .tab:hover { color:var(--ink); }
  .tab.on { color:var(--ink); background:var(--bg); border-color:var(--border); }
  .tab .label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tab.add { color:var(--faint); font-size:14px; padding:5px 11px; }

  /* The rename box is sized like the tab it replaces, so the strip does not jump. */
  .tab.renaming {
    font-family:var(--mono); font-size:12.5px; color:var(--ink); background:var(--bg);
    border:1px solid var(--brand); border-radius:7px 7px 0 0; padding:6px 10px; width:150px;
  }

  .tabclose { color:var(--faint); font-size:11px; padding:0 3px; border-radius:3px; flex:none; }
  .tabclose:hover { color:var(--del); background:var(--border); }

  /* Panels read as a segmented control, not as tabs with closable processes. */
  .pill-tab {
    font-family:var(--mono); font-size:12.5px; color:var(--muted); padding:5px 11px;
    border:1px solid transparent; border-radius:7px; background:none; cursor:pointer;
    display:inline-flex; align-items:center; gap:6px; margin-bottom:4px;
  }
  .pill-tab:hover { color:var(--ink); }
  .pill-tab.on { color:var(--brand); border-color:var(--border); background:var(--panel); }
  /* A run in flight pulses, like the working dot — it is the same fact. */
  .cbadge.live { background:var(--working); color:var(--brand-ink); animation:pulse 1.4s ease-in-out infinite; }
  .cbadge.bad { background:var(--del); color:#fff; }
  @media (prefers-reduced-motion:reduce) { .cbadge.live { animation:none; } }

  .cbadge { font-family:var(--mono); font-size:10.5px; font-weight:700; background:var(--brand); color:var(--brand-ink); border-radius:999px; padding:0 5px; min-width:15px; text-align:center; }
</style>
