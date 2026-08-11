<script lang="ts">
  /*
   * The ⋮ menu: everything global that is not worth a permanent button.
   *
   * The top bar carried seven controls in a row — Insights, four counts, Restart all,
   * Stop all, ⌘K, ⚙, ◐ and + New session — which is a lot of competing weight above
   * content you are trying to read. These are the ones you reach for rarely (settings,
   * theme, the cheatsheet) or destructively (stop everything), so they belong behind one
   * affordance rather than in front of you all day.
   *
   * Deliberately a plain popover, not a <dialog>: it must not trap focus or dim the app —
   * you open it, pick one thing, and it closes.
   */
  import { theme, toggleTheme } from '$lib/theme.svelte.js';
  import { overlays } from '$lib/stores/overlays.svelte.js';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { showShortcuts } from '$lib/shortcuts.svelte.js';

  let { onstopall, onrestartall, anyRunning = false }: {
    onstopall?: () => void;
    onrestartall?: () => void;
    anyRunning?: boolean;
  } = $props();

  let open = $state(false);
  let root = $state<HTMLElement | null>(null);

  /** Run an item and close: every item here is a one-shot. */
  function pick(fn: () => void) {
    open = false;
    fn();
  }

  /*
   * Close on any click that is not inside this menu, and on Escape.
   *
   * Bound while open only — a permanent document listener for a menu that is shut the
   * vast majority of the time is a cost paid on every click in the app.
   */
  $effect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (root && e.target instanceof Node && !root.contains(e.target)) open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      // Stop it reaching the global handler, which would read a bare Escape as "interrupt
      // the agent" and send it to the pty.
      if (e.key === 'Escape') { e.stopPropagation(); open = false; }
    };
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
  });
</script>

<div class="appmenu" bind:this={root}>
  <button
    class="btn ghost trigger"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label="Menu"
    title="Menu"
    onclick={() => (open = !open)}
  >⋮</button>

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <div class="sheet" role="menu" tabindex="-1">
      <!--
        Insights leads, because it is a DESTINATION and everything under it is an action.
        It was a permanent `◔` button in the head; the root switcher took that space, and
        of the two, which body of work you are looking at is the thing worth naming on
        screen all day. `⌘\` still opens it without coming through here.
      -->
      <button
        role="menuitem"
        class:on={ui.dockView === 'usage'}
        onclick={() => pick(() => ui.toggleUsage())}
      >
        <span class="g">◔</span> Insights
        <span class="sc">⌘\</span>
      </button>
      <div class="sep" role="separator"></div>
      <button role="menuitem" onclick={() => pick(() => overlays.togglePalette())}>
        <span class="g">⌘K</span> Command palette
      </button>
      <button role="menuitem" onclick={() => pick(() => overlays.openSearch())}>
        <span class="g">⌘⇧F</span> Search transcripts
      </button>
      <button role="menuitem" onclick={() => pick(showShortcuts)}>
        <span class="g">?</span> Keyboard shortcuts
      </button>
      <button role="menuitem" onclick={() => pick(toggleTheme)}>
        <span class="g">◐</span> {theme.current === 'light' ? 'Dark' : 'Light'} theme
      </button>
      <button role="menuitem" onclick={() => pick(() => overlays.openSettings())}>
        <span class="g">⚙</span> Settings
      </button>

      {#if anyRunning}
        <!-- Fleet-wide and destructive, so behind the menu rather than one stray click
             away in the header. -->
        <div class="sep" role="separator"></div>
        <button role="menuitem" onclick={() => pick(() => onrestartall?.())}>
          <span class="g">↻</span> Restart all servers
        </button>
        <button role="menuitem" class="danger" onclick={() => pick(() => onstopall?.())}>
          <span class="g">⏻</span> Stop all servers
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .appmenu { position: relative; display: inline-flex; }
  .trigger { font-size: 16px; line-height: 1; padding: 6px 10px; }

  .sheet {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 60;
    min-width: 216px; padding: 5px;
    background: var(--panel); border: 1px solid var(--border-strong);
    border-radius: 10px; box-shadow: var(--shadow);
    display: flex; flex-direction: column;
  }
  .sheet button {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; border: 0; border-radius: 7px;
    background: none; color: var(--ink); font: inherit; font-size: 13px;
    text-align: left; cursor: pointer; white-space: nowrap;
  }
  .sheet button:hover { background: var(--elevated); }
  /* The one item here that has a STATE — it is a view you are either in or not. */
  .sheet button.on { color: var(--brand); }
  .sheet .sc { margin-left: auto; padding-left: 14px; font-family: var(--mono); font-size: 10.5px; color: var(--faint); }
  .sheet button.danger { color: var(--del); }
  /* Fixed-width gutter so the labels line up whatever the glyph's width. */
  .sheet .g {
    flex: none; width: 26px; text-align: center;
    font-family: var(--mono); font-size: 11px; color: var(--faint);
  }
  .sep { height: 1px; margin: 5px 6px; background: var(--border); }
</style>
