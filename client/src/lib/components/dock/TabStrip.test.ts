import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import type { Session } from '../../../../../server/types';

/*
 * The tab strip's rules, all of which were wrong this morning.
 *
 * Tabs are addressed by tmux's stable window id (@7), never by array position: tmux
 * runs with `renumber-windows on`, so an index is a slot that gets reassigned when an
 * earlier window closes. The server side of that has its own regression tests; these
 * pin the CLIENT half — that the strip sends ids, keys its list on them, and does not
 * mix terminal tabs (live processes, closable) with panels (views, not closable).
 *
 * ops is mocked: every one of these verbs is an HTTP call, and what matters here is
 * WHICH id the strip decided to send.
 */
const ops = vi.hoisted(() => ({
  addTab: vi.fn(), closeTab: vi.fn(), renameTab: vi.fn(), selectTab: vi.fn(),
}));
vi.mock('$lib/ops.svelte.js', () => ops);

const { default: TabStrip } = await import('./TabStrip.svelte');
const { ui } = await import('$lib/stores/ui.svelte.js');

const session = (over: Record<string, unknown> = {}): Session => ({
  id: 's1',
  title: 'token-race-fix',
  state: 'working',
  worktreePath: '/wt',
  tabs: [
    { id: '@1', title: 'claude' },
    { id: '@7', title: 'api' },
    { id: '@9', title: 'web' },
  ],
  ...over,
} as unknown as Session);

beforeEach(() => {
  vi.clearAllMocks();
  ui.dockView = 'term';
  ui.activeTabId = '';
});

describe('TabStrip', () => {
  it('separates terminal tabs from panels — two tablists, not one row of look-alikes', () => {
    const { container } = render(TabStrip, { session: session() });
    const lists = container.querySelectorAll('[role="tablist"]');
    expect(lists).toHaveLength(2);
    expect(within(lists[0] as HTMLElement).getAllByRole('tab')).toHaveLength(3);
    // Changes / Logs / Insights — views of the session, owning no process.
    expect(within(lists[1] as HTMLElement).getAllByRole('tab')).toHaveLength(3);
  });

  it('selects by window id, not by position', () => {
    render(TabStrip, { session: session() });
    screen.getByRole('tab', { name: /api/ }).click();
    expect(ops.selectTab).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), '@7');
  });

  it('closes by window id — the whole point of not using the index', () => {
    render(TabStrip, { session: session() });
    screen.getByLabelText('Close tab api').click();
    expect(ops.closeTab).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), '@7');
  });

  it('carries a roving tabindex: one tab stop for the group', () => {
    ui.activeTabId = '@7';
    render(TabStrip, { session: session() });
    const tabs = screen.getAllByRole('tab').slice(0, 3);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('falls back to the first tab when the selected id no longer exists', () => {
    // Killed in tmux directly, or closed here — the strip must not highlight nothing
    // while a pane is still on screen.
    ui.activeTabId = '@404';
    render(TabStrip, { session: session() });
    expect(screen.getByRole('tab', { name: /claude/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('will not offer to close the only terminal tab', () => {
    render(TabStrip, { session: session({ tabs: [{ id: '@1', title: 'claude' }] }) });
    expect(screen.queryByLabelText(/^Close tab/)).not.toBeInTheDocument();
  });

  it('keeps ＋ and ⊟ Split OUTSIDE the tablist — a tablist may only hold tabs', () => {
    const { container } = render(TabStrip, { session: session() });
    const lists = [...container.querySelectorAll('[role="tablist"]')];
    expect(lists.some((l) => l.querySelector('.tab.add'))).toBe(false);
    expect(lists.some((l) => l.querySelector('.split-toggle'))).toBe(false);
    expect(screen.getByLabelText('New shell tab')).toBeInTheDocument();
  });

  it('adds a shell without asking for a name', () => {
    // It lands as "shell" and the strip renames in place; a modal to open a terminal
    // is a toll on the most common action.
    render(TabStrip, { session: session() });
    screen.getByLabelText('New shell tab').click();
    expect(ops.addTab).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('hides the worktree-only panels for an unpromoted session', () => {
    render(TabStrip, { session: session({ worktreePath: null }) });
    expect(screen.queryByRole('tab', { name: /Changes/ })).not.toBeInTheDocument();
    // Insights is not gated on promotion: a transcript exists before a worktree does.
    expect(screen.getByRole('tab', { name: /Insights/ })).toBeInTheDocument();
  });
});
