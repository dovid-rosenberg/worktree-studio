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

  /**
   * The selected tab, resolved against tabs that actually exist. If the stored id is
   * gone — closed here, or killed in tmux directly — fall back to the first tab rather
   * than highlighting nothing while a pane is still on screen.
   */
  const activeId = $derived(
    tabs.some((t) => t.id === ui.activeTabId) ? ui.activeTabId : (tabs[0]?.id ?? ''),
  );

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
    {/if}

    <!-- Available for any session: a transcript exists before a worktree does. -->
  </div>
</div>

<style>
  .tabstrip { display:flex; align-items:flex-end; gap:8px; padding:8px 12px 0; background:var(--elevated); border-bottom:1px solid var(--border); flex:none; flex-wrap:wrap; }
  .group { display:flex; align-items:flex-end; gap:3px; min-width:0; }
  .spring { flex:1; }

  .tab {
    font-family:var(--mono); font-size:11.5px; color:var(--muted); padding:6px 10px;
    border-radius:7px 7px 0 0; display:flex; align-items:center; gap:7px;
    border:1px solid transparent; border-bottom:none; cursor:pointer;
    background:none; max-width:190px; min-width:0;
  }
  .tab:hover { color:var(--ink); }
  .tab.on { color:var(--ink); background:var(--bg); border-color:var(--border); }
  .tab .label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tab.add { color:var(--faint); font-size:13px; padding:5px 11px; }

  /* The rename box is sized like the tab it replaces, so the strip does not jump. */
  .tab.renaming {
    font-family:var(--mono); font-size:11.5px; color:var(--ink); background:var(--bg);
    border:1px solid var(--brand); border-radius:7px 7px 0 0; padding:6px 10px; width:150px;
  }

  .tabclose { color:var(--faint); font-size:10px; padding:0 3px; border-radius:3px; flex:none; }
  .tabclose:hover { color:var(--del); background:var(--border); }

  /* Panels read as a segmented control, not as tabs with closable processes. */
  .pill-tab {
    font-family:var(--mono); font-size:11.5px; color:var(--muted); padding:5px 11px;
    border:1px solid transparent; border-radius:7px; background:none; cursor:pointer;
    display:inline-flex; align-items:center; gap:6px; margin-bottom:4px;
  }
  .pill-tab:hover { color:var(--ink); }
  .pill-tab.on { color:var(--brand); border-color:var(--border); background:var(--panel); }

  .cbadge { font-family:var(--mono); font-size:9.5px; font-weight:700; background:var(--brand); color:var(--brand-ink); border-radius:999px; padding:0 5px; min-width:15px; text-align:center; }
</style>
