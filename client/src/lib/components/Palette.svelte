<script lang="ts">
  /*
   * The ⌘K command palette: fuzzy-ish filter over every session, then the commands that
   * apply to the current selection.
   *
   * The ⌘1–9 hints come from the rail's display order, not from the session array, so
   * "⌘3" in the palette and the third card in the rail are always the same session.
   */
  import Modal from '$lib/components/Modal.svelte';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';
  import { overlays } from '$lib/stores/overlays.svelte.js';
  import { showShortcuts } from '$lib/shortcuts.svelte.js';
  import { activateSession, deactivateSession, promote, runStack } from '$lib/ops.svelte.js';

  let query = $state('');
  let hi = $state(0);
  let input = $state<HTMLInputElement|null>(null);
  let listEl = $state<HTMLElement|null>(null);

  const q = $derived(query.trim().toLowerCase());

  /** id → position in the rail, for the ⌘N hint. */
  const railIdx = $derived(new Map(ui.railOrder.map((/** @type {any} */ s, /** @type {number} */ i) => [s.id, i])));

  const sessionRows = $derived(
    world.sessions
      .filter((s) => !q || `${s.title} ${s.repoName} ${s.state}`.toLowerCase().includes(q))
      .map((s) => {
        const i = railIdx.get(s.id);
        return {
          key: `s:${s.id}`,
          glyph: s.worktreePath ? '⎇' : '✦',
          dot: s.state,
          title: s.title,
          // ⌥, not ⌘: shortcuts.svelte.ts binds altKey + Digit1-9 (⌘-digit belongs to the
          // browser's tab switcher). The palette advertised a key that did nothing.
          sub: `${s.repoName} · ${s.state}${i != null && i < 9 ? ` · ⌥${i + 1}` : ''}`,
          run: () => { overlays.closePalette(); ui.goToSession(s.id); },
        };
      }),
  );

  const commandRows = $derived((() => {
    const cur = ui.selected;
        const cmds: {key:string, glyph:string, title:string, sub:string, run:()=>void}[] = [];
    const add = (glyph: string, title: string, sub: string, run: () => void) =>
      cmds.push({ key: `c:${title}`, glyph, title, sub, run });

    add('＋', 'New session', '⌘N', () => overlays.openIntake());
    add('⌕', 'Search transcripts', '⌘⇧F', () => overlays.openSearch());
    if (cur && !cur.worktreePath) add('⤴', 'Promote current to worktree', '⌘↵', () => promote(cur));
    if (cur && cur.worktreePath) add('✎', 'Review changes', '⌘D', () => { ui.goToSession(cur.id); ui.dockView = 'changes'; });
    // Opens the one Insights view already drilled into this session.
    if (cur) add('◔', 'Session insights', '', () => ui.openInsights(cur.id));
    // Was labelled 'Run stack' while calling startSessionServers — the other verb.
    if (cur && cur.worktreePath && cur.feature) add('▶', 'Run stack', '⌘R', () => runStack(cur.feature));
    add('◔', 'Insights', '⌘\\', () => ui.toggleUsage());
    if (cur) {
      if (cur.active === false) add('↻', 'Resume current', '', () => activateSession(cur));
      else add('⏻', 'Deactivate current', '', () => deactivateSession(cur));
    }
    add('⚙', 'Open Settings', '', () => overlays.openSettings());
    add('?', 'Keyboard shortcuts', '?', () => showShortcuts());

    return cmds
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .map((c) => ({ ...c, dot: '', run: () => { overlays.closePalette(); c.run(); } }));
  })());

  const rows = $derived([...sessionRows, ...commandRows]);

  // Any change to the result set puts the highlight back on the first row, so typing
  // never leaves it pointing at a row that scrolled out from under it.
  $effect(() => {
    void rows.length;
    hi = 0;
  });

  $effect(() => {
    queueMicrotask(() => input?.focus());
  });

  /** @param {number} d */
  function move(d: number) {
    if (!rows.length) return;
    hi = (hi + d + rows.length) % rows.length;
    listEl?.querySelectorAll<HTMLElement>('.pcmd')[hi]?.scrollIntoView({ block: 'nearest' });
  }

  /** @param {KeyboardEvent} e */
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); rows[hi]?.run(); }
  }
</script>

<Modal backdropClass="top" panelClass="palette" label="Command palette" onclose={() => overlays.closePalette()}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="palette-inner" role="search" onkeydown={onKeydown}>
    <input
      type="text"
      spellcheck="false"
      autocomplete="off"
      placeholder="Jump to a session or run a command…"
      aria-label="Command palette"
      bind:value={query}
      bind:this={input}
    />
    <div class="palette-list" bind:this={listEl}>
      {#if sessionRows.length}<div class="psec">Sessions</div>{/if}
      {#each sessionRows as r, i (r.key)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="pcmd" class:on={hi === i} onclick={r.run} onmousemove={() => (hi = i)}>
          <span class="pg">{r.glyph}</span>
          <span class="dot {r.dot}"></span>
          <span class="ptitle">{r.title}</span>
          <span class="psub">{r.sub}</span>
        </div>
      {/each}

      {#if commandRows.length}<div class="psec">Commands</div>{/if}
      {#each commandRows as r, i (r.key)}
        {@const idx = sessionRows.length + i}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="pcmd" class:on={hi === idx} onclick={r.run} onmousemove={() => (hi = idx)}>
          <span class="pg">{r.glyph}</span>
          <span class="ptitle">{r.title}</span>
          {#if r.sub}<span class="psub">{r.sub}</span>{/if}
        </div>
      {/each}

      {#if !rows.length}<div class="psec">No matches</div>{/if}
    </div>
  </div>
</Modal>

<style>
  .palette-inner { display:flex; flex-direction:column; min-height:0; }
  .palette-inner input { width:100%; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--ink); font-size:17px; padding:15px 18px; outline:none; font-family:var(--sans); }
  /* The suppressed outline is replaced by a brand underline, so keyboard focus stays visible. */
  .palette-inner input:focus-visible { outline:none; border-bottom-color:var(--brand); }
  .palette-list { max-height:340px; overflow:auto; padding:6px; }
  .psec { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); padding:8px 12px 4px; }
  .pcmd { display:flex; align-items:center; gap:11px; padding:9px 12px; border-radius:9px; cursor:pointer; font-size:14.5px; }
  .pcmd.on { background:var(--elevated); }
  .pcmd .pg { width:20px; text-align:center; color:var(--brand); flex:none; }
  .pcmd .dot { flex:none; }
  .pcmd .ptitle { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pcmd .psub { margin-left:auto; padding-left:12px; font-family:var(--mono); font-size:11.5px; color:var(--faint); white-space:nowrap; flex:none; }
</style>
