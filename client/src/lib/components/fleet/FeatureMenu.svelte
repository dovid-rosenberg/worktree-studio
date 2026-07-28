<script lang="ts">
  /*
   * The ⋯ overflow menu on a Fleet feature row.
   *
   * Behaviour that has to survive the port, because it is what makes the menu usable
   * without a mouse:
   *  - roving focus with ↑/↓, wrapping;
   *  - Escape closes and returns focus to the ⋯ trigger;
   *  - activating an item closes the menu and restores focus BEFORE running the action,
   *    so an action that opens a dialog does not leave focus orphaned on a removed node;
   *  - an outside click closes it.
   *
   * In app.js this menu was appended to <body> and re-created on every SSE tick along
   * with the row. Here it is a component the row owns, so a frame arriving while the
   * menu is open no longer closes it.
   */
  import { onMount } from 'svelte';

  interface MenuItem {
    label?: string;
    run?: () => void;
    danger?: boolean;
    sep?: boolean;
  }

    let {
    /** The ⋯ button; used for positioning and for focus restore. */
    anchor,
    /** `sep: true` renders a divider instead of an item. */
    items = [],
    onclose,
  }: { anchor: HTMLElement, items?: MenuItem[], onclose?: () => void } = $props();

  let menu = $state<HTMLElement|null>(null);
  let top = $state(0);
  let left = $state(0);

  const actionable = $derived(items.filter((i) => !i.sep));

  onMount(() => {
    // Measure after mount: the left edge depends on the menu's own width.
    const rect = anchor.getBoundingClientRect();
    top = rect.bottom + 4;
    left = Math.max(8, rect.right - (menu?.offsetWidth ?? 160));
    /** @type {HTMLElement|null} */ (menu?.querySelector<HTMLElement>('[role="menuitem"]'))?.focus();

    // Deferred by a tick so the click that opened the menu doesn't immediately close it.
    /** @param {MouseEvent} e */
    const onDocClick = (e: any) => {
      if (menu && e.target instanceof Node && menu.contains(e.target)) return;
      onclose?.();
    };
    const t = setTimeout(() => document.addEventListener('click', onDocClick), 0);
    return () => { clearTimeout(t); document.removeEventListener('click', onDocClick); };
  });

  /** @param {{run?:()=>void}} item */
  function activate(item: any) {
    onclose?.();
    anchor?.focus?.();
    item.run?.();
  }

  /** @param {KeyboardEvent} e */
  function onKeydown(e: any) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onclose?.();
      anchor?.focus?.();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const els = [.../** @type {NodeListOf<HTMLElement>} */ (menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!els.length) return;
    const i = els.indexOf((document.activeElement as HTMLElement));
    const d = e.key === 'ArrowDown' ? 1 : -1;
    els[(i + d + els.length) % els.length].focus();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="fmenu"
  role="menu"
  aria-label="Feature actions"
  tabindex="-1"
  bind:this={menu}
  style="top:{top}px; left:{left}px"
  onkeydown={onKeydown}
>
  {#each items as item, i (i)}
    {#if item.sep}
      <div class="sep"></div>
    {:else}
      <div
        role="menuitem"
        tabindex="0"
        class:danger={item.danger}
        onclick={() => activate(item)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(item); } }}
      >{item.label}</div>
    {/if}
  {/each}
  {#if !actionable.length}<div class="sep"></div>{/if}
</div>

<style>
  .fmenu { position:fixed; background:var(--panel); border:1px solid var(--border-strong); border-radius:9px; box-shadow:var(--shadow); padding:5px; min-width:160px; z-index:70; }
  .fmenu div[role="menuitem"] { font-size:12.5px; padding:6px 10px; border-radius:6px; color:var(--ink); cursor:pointer; }
  .fmenu div[role="menuitem"]:hover { background:var(--elevated); }
  .fmenu div[role="menuitem"].danger { color:#e5484d; }
  .fmenu .sep { height:1px; background:var(--border); margin:4px 2px; padding:0; cursor:default; }
</style>
