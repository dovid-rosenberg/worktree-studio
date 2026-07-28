<script lang="ts">
  // Harness for the transcript-search surface. Not the shell — the shell agent mounts
  // SearchPanel / SearchOverlay wherever they belong. This exists so search can be
  // developed and proved against a live daemon on its own, in both of the shapes it
  // will be used in: docked into a pane, and as the command palette.
  import SearchPanel from '$lib/components/insights/SearchPanel.svelte';
  import SearchOverlay from '$lib/components/insights/SearchOverlay.svelte';
  import { listSessions } from '$lib/components/insights/api.js';
  import { stamp } from '$lib/components/insights/format.js';
  import { theme, toggleTheme } from '$lib/theme.svelte.js';

    let sessions: import('$lib/components/insights/types.js').StateSession[] = $state([]);
  let scoped = $state('');
  let overlay = $state(false);
    let picked: import('$lib/components/insights/types.js').Hit|null = $state(null);

  $effect(() => {
    listSessions().then((s) => { sessions = s; }).catch(() => {});
  });

  /** @param {import('$lib/components/insights/types.js').Hit} hit */
  function onopen(hit: any) {
    picked = hit;
    overlay = false;
  }

  /** @param {KeyboardEvent} e */
  function onWindowKey(e: any) {
    // Stands in for the shell's global shortcut so the overlay can be exercised the
    // way it will actually be opened.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); overlay = !overlay; }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="harness">
  <header class="topbar">
    <div class="brand"><span class="glyph">◧</span> Transcript search</div>
    <span class="muxbadge">harness</span>
    <span class="spacer"></span>
    <label class="pick">
      <span>mount scoped to</span>
      <select class="mini-select" bind:value={scoped}>
        <option value="">nothing (global panel)</option>
        {#each sessions as s (s.id)}<option value={s.id}>{s.title}</option>{/each}
      </select>
    </label>
    <button class="btn sm" onclick={() => { overlay = true; }}>Open as palette <kbd>⌘P</kbd></button>
    <button class="btn ghost sm" onclick={toggleTheme}>{theme.current === 'dark' ? '☀' : '☾'}</button>
    <a class="btn ghost sm" href="/usage">Usage →</a>
  </header>

  {#if picked}
    <div class="picked">
      <b>onopen fired</b> — the shell would focus session <code>{picked.sessionId}</code> at message
      <code>{picked.uuid.slice(0, 8)}</code> ({picked.role}, {stamp(picked.tsMs)}).
      <button class="btn ghost xs" onclick={() => { picked = null; }}>dismiss</button>
    </div>
  {/if}

  <main class="pane">
    {#key scoped}
      <SearchPanel sessionId={scoped || null} {sessions} {onopen} />
    {/key}
  </main>
</div>

<SearchOverlay open={overlay} {sessions} {onopen} onclose={() => { overlay = false; }} />

<style>
  .harness { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .topbar {
    display: flex; align-items: center; gap: 12px; row-gap: 8px; flex-wrap: wrap;
    padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--panel); flex: none;
  }
  .brand { font-weight: 700; font-size: 15px; letter-spacing: -.01em; display: flex; align-items: center; gap: 7px; }
  .brand .glyph { color: var(--brand); font-size: 17px; }
  .muxbadge { font-family: var(--mono); font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; }
  .pick { display: inline-flex; align-items: center; gap: 6px; }
  .pick > span { font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
  kbd { font-family: var(--mono); font-size: 10px; color: var(--faint); }

  .picked {
    padding: 9px 16px; background: var(--brand-soft); border-bottom: 1px solid var(--border);
    font-size: 12.5px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  .picked code { font-family: var(--mono); font-size: 11.5px; }

  .pane { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
  .pane :global(> section) { flex: 1; min-height: 0; }
</style>
