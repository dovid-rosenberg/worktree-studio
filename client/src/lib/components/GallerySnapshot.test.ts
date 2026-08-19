import { describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

/*
 * The gallery's snapshot loop, exercised without a browser.
 *
 * /gallery cannot render twelve live <ActionBar/>s: the bar reads the global stores, so
 * every instance would show whichever state was installed last. It instead installs a
 * state, mounts into a detached node, flushes, captures the markup and unmounts. That
 * loop is the one genuinely novel thing on the page, and asserting it here is worth more
 * than driving a browser: it runs in CI, and it fails on the mechanism rather than on
 * whatever else a real page happened to be doing.
 */
vi.mock('$lib/components/RunConfigMenu.svelte', () => ({ default: vi.fn() as never }));
vi.mock('$lib/components/SlotMenu.svelte', () => ({ default: vi.fn() as never }));

const { default: ActionBar } = await import('./ActionBar.svelte');
const { ui } = await import('$lib/stores/ui.svelte.js');
const { world } = await import('$lib/stores/world.svelte.js');
const fx = await import('$lib/fixtures/world.js');
const { GALLERY_STATES } = await import('$lib/fixtures/states.js');

/** Exactly what +page.svelte does, so a break here is a break there. */
function snapshotAll() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const out: { name: string; html: string }[] = [];
  for (const s of GALLERY_STATES) {
    s.apply(fx, world as never, ui as never);
    const app = mount(ActionBar, { target: host });
    flushSync();
    out.push({ name: s.name, html: host.innerHTML });
    unmount(app);
  }
  host.remove();
  return out;
}

describe('gallery snapshot loop', () => {
  const cells = snapshotAll();

  it('produces one cell per state', () => {
    expect(cells).toHaveLength(GALLERY_STATES.length);
  });

  it('every cell captured real markup', () => {
    for (const c of cells) {
      expect(c.html, `${c.name} rendered nothing`).toContain('actionbar');
      expect(c.html.length, `${c.name} looks empty`).toBeGreaterThan(80);
    }
  });

  it('states are actually distinguishable, not twelve copies of one bar', () => {
    // The failure this guards is subtle and total: if the store swap did not take, every
    // cell would be a perfect copy and the page would look fine while showing one state.
    const unique = new Set(cells.map((c) => c.html));
    expect(unique.size).toBeGreaterThan(cells.length / 2);
  });

  it('the selected states differ from the empty one', () => {
    const empty = cells.find((c) => c.name === 'nothing selected');
    const selected = cells.filter((c) => c.name !== 'nothing selected');
    for (const c of selected) expect(c.html, `${c.name} matches the empty bar`).not.toBe(empty?.html);
  });
});
