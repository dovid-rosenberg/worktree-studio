<script lang="ts">
/*
 * The `⋯` menu on the action bar.
 *
 * A second menu shell rather than a reuse of AppMenu: that one is a fixed list of
 * app-level commands, this one takes whatever the caller puts in it. What IS shared is
 * the behaviour worth getting right once — dismiss on an outside click, dismiss on
 * Escape WITHOUT letting Escape reach the global handler (which reads a bare Escape as
 * "interrupt the agent" and sends it to the pty), and closing before the action runs so
 * a dialog does not open behind an open menu.
 *
 * Right-aligned, because it lives at the right-hand end of the bar and a left-aligned
 * sheet would hang off the window.
 */
import type { Snippet } from 'svelte';

/** The snippet is handed `pick`, which closes the menu and then runs its argument. */
type Pick = (fn: () => void) => void;

let { children, label = 'More actions' }: { children: Snippet<[Pick]>; label?: string } = $props();

let open = $state(false);
let root = $state<HTMLElement | null>(null);

/** Close first, then act — a dialog must not appear behind a menu that is still up. */
function pick(fn: () => void) {
  open = false;
  fn();
}

$effect(() => {
  if (!open) return;
  const onDocClick = (e: MouseEvent) => {
    if (root && e.target instanceof Node && !root.contains(e.target)) open = false;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      open = false;
    }
  };
  // Capture phase: the global shortcut handler is on document too, and it would send a
  // bare Escape to the terminal before this saw it.
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onKey, true);
  return () => {
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey, true);
  };
});
</script>

<div class="ovf" bind:this={root}>
  <button
    class="btn sm ghost trigger"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={label}
    title={label}
    onclick={() => (open = !open)}
  >⋯</button>

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <div class="sheet" role="menu" tabindex="-1">
      {@render children(pick)}
    </div>
  {/if}
</div>

<style>
  .ovf { position: relative; display: inline-flex; }
  .trigger { font-size: 15px; line-height: 1; padding: 5px 9px; }

  .sheet {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 60;
    min-width: 208px; padding: 5px;
    background: var(--panel); border: 1px solid var(--border-strong);
    border-radius: 10px; box-shadow: var(--shadow);
    display: flex; flex-direction: column;
  }
  /* :global — the items are the caller's markup, so they are not scoped to this file. */
  .sheet :global(button) {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; border: 0; border-radius: 7px;
    background: none; color: var(--ink); font: inherit; font-size: 13px;
    text-align: left; cursor: pointer; white-space: nowrap; width: 100%;
  }
  .sheet :global(button:hover) { background: var(--elevated); }
  .sheet :global(button.danger) { color: var(--del); }
  /* Fixed-width gutter so labels line up whatever the glyph's width. */
  .sheet :global(.g) {
    flex: none; width: 22px; text-align: center;
    font-family: var(--mono); font-size: 12px; color: var(--faint);
  }
  .sheet :global(.sep) { height: 1px; margin: 5px 6px; background: var(--border); }
</style>
