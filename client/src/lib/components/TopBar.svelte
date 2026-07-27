<script>
  import { theme, toggleTheme } from '$lib/theme.svelte.js';

  // `actions` is a snippet so the port can add the palette / settings / new-session
  // buttons as those features land, without this component having to know about them.
  let { mux = '…', actions } = $props();
</script>

<header class="topbar">
  <div class="brand"><span class="glyph">⎇</span> Worktree&nbsp;Studio</div>
  <span class="muxbadge" title="active multiplexer">{mux}</span>
  <span class="spacer"></span>
  {@render actions?.()}
  <button
    class="btn ghost"
    onclick={toggleTheme}
    title="Toggle theme"
    aria-label="Toggle theme"
    aria-pressed={theme.current === 'light'}
  >◐</button>
</header>

<style>
  .topbar { display:flex; align-items:center; gap:12px; row-gap:8px; flex-wrap:wrap; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--panel); flex:none; }
  .brand { font-weight:700; font-size:15px; letter-spacing:-.01em; display:flex; align-items:center; gap:7px; }
  .brand .glyph { color:var(--brand); font-size:17px; }
  .muxbadge { font-family:var(--mono); font-size:11px; color:var(--muted); border:1px solid var(--border); border-radius:6px; padding:2px 8px; }
</style>
