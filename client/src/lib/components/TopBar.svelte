<script>
  /*
   * The application header: brand, multiplexer badge, the Work/Fleet segment (with the
   * waiting-count attention badge), and the global actions.
   *
   * The `actions` snippet is kept from the foundation version so a caller can inject
   * extra controls without this component learning about them.
   */
  import { theme, toggleTheme } from '$lib/theme.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { overlays } from '$lib/stores/overlays.svelte.js';
  import { notify } from '$lib/stores/notify.svelte.js';

  let { actions = undefined } = $props();
</script>

<header class="topbar">
  <div class="brand"><span class="glyph">⎇</span> Worktree&nbsp;Studio</div>
  <span class="muxbadge" title="active multiplexer">mux: {world.mux}</span>

  <div class="viewseg" role="group" aria-label="View">
    <button class:on={ui.view === 'work'} aria-pressed={ui.view === 'work'} onclick={() => ui.setView('work')}>◧ Work</button>
    <!-- data-n drives the ::after badge; 0 hides it (see the .attn rules). -->
    <button
      class="attn"
      class:on={ui.view === 'fleet'}
      aria-pressed={ui.view === 'fleet'}
      data-n={notify.waitingCount}
      title={notify.waitingCount ? `${notify.waitingCount} session(s) waiting for you` : 'Fleet'}
      onclick={() => ui.setView('fleet')}
    >▦ Fleet</button>
  </div>

  <span class="spacer"></span>
  {@render actions?.()}

  <button class="btn ghost" title="Command palette (⌘K)" aria-label="Command palette" onclick={() => overlays.togglePalette()}>⌘K</button>
  <button class="btn ghost" title="Connections & settings" aria-label="Connections & settings" onclick={() => overlays.openSettings()}>⚙</button>
  <button
    class="btn ghost"
    onclick={toggleTheme}
    title="Toggle theme"
    aria-label="Toggle theme"
    aria-pressed={theme.current === 'light'}
  >◐</button>
  <button class="btn primary" onclick={() => overlays.openIntake()}>+ New session</button>
</header>

<style>
  .topbar { display:flex; align-items:center; gap:12px; row-gap:8px; flex-wrap:wrap; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--panel); flex:none; }
  .brand { font-weight:700; font-size:15px; letter-spacing:-.01em; display:flex; align-items:center; gap:7px; }
  .brand .glyph { color:var(--brand); font-size:17px; }
  .muxbadge { font-family:var(--mono); font-size:11px; color:var(--muted); border:1px solid var(--border); border-radius:6px; padding:2px 8px; }

  .viewseg { display:flex; background:var(--elevated); border:1px solid var(--border); border-radius:9px; padding:2px; gap:2px; }
  .viewseg button { font-family:var(--sans); font-size:12px; font-weight:600; border:0; background:transparent; color:var(--muted); padding:5px 13px; border-radius:7px; cursor:pointer; }
  .viewseg button.on { background:var(--brand); color:var(--brand-ink); }

  /* Attention badge: the number of sessions currently waiting. */
  .attn { position:relative; }
  .attn::after { content:attr(data-n); position:absolute; top:-6px; right:-6px; min-width:16px; height:16px; padding:0 4px; background:var(--waiting); color:#241a06; font-family:var(--mono); font-size:10px; font-weight:700; border-radius:999px; display:grid; place-items:center; box-shadow:0 0 0 2px var(--panel); }
  .attn[data-n="0"]::after, .attn:not([data-n])::after { display:none; }
</style>
