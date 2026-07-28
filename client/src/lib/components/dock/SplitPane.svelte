<script>
  /*
   * The split pane: a SECOND, independent terminal beside the primary, backed by the
   * standalone `<muxName>-split` session. Nothing mirrors — it has its own window list,
   * so it is simply "another terminal in the same worktree".
   *
   * It is the *same* Terminal component as the primary, with `pane="split"`. That is
   * the whole reason app.js's term2/fit2/ws2/ro2 globals and their parallel
   * open/connect/resize/destroy functions are gone: this file owns only the tab strip.
   */
  import Terminal from '$lib/components/Terminal.svelte';
  import { activatable } from '$lib/actions/activatable.js';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toasts.svelte.js';

  let { session } = $props();

  /** @type {{title:string, active?:boolean}[]} */
  let tabs = $state([]);
  let activeIndex = $state(0);
  let term = $state(/** @type {any} */ (null));
  let busyAdd = $state(false);

  const shown = $derived(tabs.length ? tabs : [{ title: 'shell' }]);

  /**
   * Load the split session's tab list. The GET also *creates* the session with a shell
   * if it does not exist yet, so this runs before the socket attaches.
   * @param {string} id
   */
  async function fetchTabs(id) {
    try {
      const r = await api('GET', `/api/sessions/${id}/split/tabs`);
      tabs = r.tabs || [];
      const ai = tabs.findIndex((t) => t.active);
      activeIndex = ai >= 0 ? ai : 0;
    } catch { tabs = []; activeIndex = 0; }
  }

  // Re-runs on session change: the pane follows the selection like the primary does.
  $effect(() => { fetchTabs(session.id); });

  /** @param {number} i */
  async function select(i) {
    activeIndex = i;
    try {
      await api('POST', `/api/sessions/${session.id}/split/select-tab`, { index: i });
      term?.focus();
    } catch (e) { toast(/** @type {Error} */ (e).message, true); }
  }

  async function add() {
    if (busyAdd) return;
    busyAdd = true;
    try {
      await api('POST', `/api/sessions/${session.id}/split/tabs`, { title: 'shell' });
      await fetchTabs(session.id);
      activeIndex = Math.max(0, tabs.length - 1);
      await api('POST', `/api/sessions/${session.id}/split/select-tab`, { index: activeIndex });
    } catch (e) { toast(/** @type {Error} */ (e).message, true); }
    finally { busyAdd = false; }
  }

  /** @param {number} i */
  async function close(i) {
    try {
      await api('POST', `/api/sessions/${session.id}/split/close-tab`, { index: i });
      await fetchTabs(session.id);
    } catch (e) { toast(/** @type {Error} */ (e).message, true); }
  }
</script>

<div class="panewrap">
  <div class="panehd">
    <div class="splittabs">
      {#each shown as t, i (i)}
        <span class="tab sm" class:on={i === activeIndex} use:activatable={() => select(i)}>
          {t.title}
          {#if shown.length > 1}
            <span
              class="tabclose"
              title="Close tab"
              aria-label="Close tab"
              use:activatable={(e) => { e?.stopPropagation(); close(i); }}
            >✕</span>
          {/if}
        </span>
      {/each}
      <span class="tab sm" aria-label="New split tab" use:activatable={add}><span class="newtab">＋</span></span>
    </div>
  </div>
  <!-- autofocus={false}: only one pane on screen may take the keyboard, and the
       primary (the Claude session) is the one that should. -->
  <Terminal bind:this={term} sessionId={session.id} pane="split" autofocus={false} />
</div>

<style>
  .panewrap { display:flex; flex-direction:column; min-width:0; min-height:0; }
  .panehd { font-family:var(--mono); font-size:10.5px; color:var(--muted); padding:5px 10px; background:var(--elevated); border-bottom:1px solid var(--border); display:flex; align-items:center; gap:6px; flex:none; }
  .splittabs { display:flex; align-items:center; gap:3px; flex-wrap:wrap; }
  .tab.sm { font-size:10.5px; padding:2px 8px; border-radius:5px; border:1px solid transparent; cursor:pointer; color:var(--muted); display:inline-flex; align-items:center; gap:5px; }
  .tab.sm:hover { color:var(--ink); }
  .tab.sm.on { color:var(--ink); background:var(--bg); border-color:var(--border); }
  .tabclose { color:var(--faint); font-size:10px; padding:0 2px; border-radius:3px; }
  .tabclose:hover { color:var(--ink); background:var(--border); }
  .newtab { color:var(--faint); }
</style>
