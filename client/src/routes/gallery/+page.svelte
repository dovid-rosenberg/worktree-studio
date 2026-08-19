<script lang="ts">
/*
 * The state gallery: every shape the action bar takes, on one page.
 *
 * The bar is the hardest thing here to know you have not broken — 27 controls behind six
 * derived flags across four selection kinds — and nothing in the app ever showed more
 * than one of those states at a time. So a regression in a state you were not currently
 * looking at was invisible until you happened to select the right thing.
 *
 * HOW, and why it is not just twelve <ActionBar/> tags: the bar reads the global `world`
 * and `ui` stores, so twelve live instances would all show whichever state was installed
 * last. Instead each state is installed, mounted into a detached node, flushed, and its
 * markup captured — then rendered as static HTML. The scoped style classes are in that
 * markup, so it looks like the real thing; the handlers are gone, which is correct for a
 * gallery. Nothing here can act on your fleet.
 */
import { flushSync, mount, unmount } from 'svelte';
import ActionBar from '$lib/components/ActionBar.svelte';
import * as fx from '$lib/fixtures/world.js';
import { ui } from '$lib/stores/ui.svelte.js';
import { world } from '$lib/stores/world.svelte.js';
import { GALLERY_STATES } from '$lib/fixtures/states.js';

let cells = $state<{ name: string; note: string; html: string }[]>([]);

function snapshot() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const out: { name: string; note: string; html: string }[] = [];
  for (const s of GALLERY_STATES) {
    s.apply(fx, world, ui);
    const app = mount(ActionBar, { target: host });
    flushSync();
    out.push({ name: s.name, note: s.note, html: host.innerHTML });
    unmount(app);
  }
  host.remove();
  cells = out;
}

$effect(() => {
  snapshot();
  return () => ui.clearSelection();
});
</script>

<svelte:head><title>Action bar · state gallery</title></svelte:head>

<div class="gal">
  <header>
    <h1>Action bar — every state</h1>
    <p>
      Rendered from <code>$lib/fixtures/world</code>, the same factory the component tests
      use. Static markup: these are pictures, not controls.
      <strong>{cells.length}</strong> states.
    </p>
  </header>

  <div class="grid">
    {#each cells as c (c.name)}
      <section class="cell">
        <h2>{c.name}</h2>
        <p class="note">{c.note}</p>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- our own component's output -->
        <div class="shot">{@html c.html}</div>
      </section>
    {/each}
  </div>
</div>

<style>
  .gal { padding: 26px 24px 70px; max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
  header { display: flex; flex-direction: column; gap: 6px; }
  h1 { margin: 0; font-size: 22px; letter-spacing: -.01em; }
  header p { margin: 0; color: var(--muted); font-size: 14px; }
  header code { font-family: var(--mono); font-size: 12.5px; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 12px; }
  .cell {
    border: 1px solid var(--border); border-radius: 10px; background: var(--panel);
    display: flex; flex-direction: column; overflow: hidden;
  }
  .cell h2 {
    margin: 0; padding: 9px 12px 3px; font-family: var(--mono); font-size: 11px;
    letter-spacing: .07em; text-transform: uppercase; color: var(--brand); font-weight: 700;
  }
  .cell .note { margin: 0; padding: 0 12px 9px; font-size: 12.5px; color: var(--muted); }
  /* The bar is position-fixed in the app; in a cell it has to sit in flow. */
  .shot { border-top: 1px solid var(--border); background: var(--bg); overflow-x: auto; }
  .shot :global(.actionbar) { position: static !important; width: auto !important; }
</style>
