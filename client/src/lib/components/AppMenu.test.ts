import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';

/*
 * The ⋮ menu holds everything global that is not worth permanent width.
 *
 * Every item is a ONE-SHOT — it acts and the menu closes. That used to be untrue: Insights
 * was a destination you could be IN, and it carried a selected state the others did not.
 * With it gone the invariant is uniform, and these tests pin the two halves of it — an
 * item acts, and the menu shuts behind it.
 */
vi.mock('$lib/shortcuts.svelte.js', () => ({ showShortcuts: vi.fn() }));

const { default: AppMenu } = await import('./AppMenu.svelte');
const { overlays } = await import('$lib/stores/overlays.svelte.js');

const open = async (name: RegExp) => {
  render(AppMenu);
  screen.getByLabelText('Menu').click();
  return screen.findByRole('menuitem', { name });
};

beforeEach(() => {
  overlays.closeSearch();
  overlays.closePalette();
});

describe('AppMenu', () => {
  it('names the shortcut beside each item that has one, so the menu teaches its own bypass', async () => {
    const item = await open(/Search transcripts/);
    expect(item.textContent).toContain('⌘⇧F');
  });

  it('acts and closes: picking Search transcripts opens the overlay and shuts the sheet', async () => {
    const item = await open(/Search transcripts/);
    item.click();
    await tick();
    expect(overlays.search).toBe(true);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps the destructive fleet verbs out until something is actually running', async () => {
    render(AppMenu, { props: { anyRunning: false } });
    screen.getByLabelText('Menu').click();
    expect(screen.queryByRole('menuitem', { name: /Stop all servers/ })).not.toBeInTheDocument();
  });
});
