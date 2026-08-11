import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';

/*
 * The ⋮ menu holds everything global that is not worth permanent width.
 *
 * Insights moved in when the root switcher took the rail head's space: of the two, which
 * body of work you are looking at is the thing worth naming on screen all day. That makes
 * it the one item here with a STATE — every other entry is a one-shot — so it is also the
 * one that can be got wrong by a refactor that treats them all alike.
 */
vi.mock('$lib/shortcuts.svelte.js', () => ({ showShortcuts: vi.fn() }));

const { default: AppMenu } = await import('./AppMenu.svelte');
const { ui } = await import('$lib/stores/ui.svelte.js');

const open = async () => {
  render(AppMenu);
  screen.getByLabelText('Menu').click();
  return screen.findByRole('menuitem', { name: /Insights/ });
};

beforeEach(() => {
  ui.dockView = 'term';
});

describe('AppMenu', () => {
  it('carries Insights, and names the shortcut that skips the menu entirely', async () => {
    const item = await open();
    expect(item).toBeInTheDocument();
    // Behind two clicks now, so the one-key route has to be on the label — otherwise the
    // move quietly makes a destination you use all day more expensive to reach.
    expect(item.textContent).toContain('⌘\\');
  });

  it('opens Insights when picked', async () => {
    const item = await open();
    item.click();
    expect(ui.dockView).toBe('usage');
  });

  it('shows that you are already in Insights, rather than offering it blankly', async () => {
    ui.dockView = 'usage';
    const item = await open();
    expect(item.className).toContain('on');
  });

  it('keeps the destructive fleet verbs out until something is actually running', async () => {
    render(AppMenu, { props: { anyRunning: false } });
    screen.getByLabelText('Menu').click();
    expect(screen.queryByRole('menuitem', { name: /Stop all servers/ })).not.toBeInTheDocument();
  });
});
