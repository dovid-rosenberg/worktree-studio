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
  addTab: vi.fn(),
  closeTab: vi.fn(),
  renameTab: vi.fn(),
  selectTab: vi.fn(),
}));
vi.mock('$lib/ops.svelte.js', () => ops);

const { default: TabStrip } = await import('./TabStrip.svelte');
const { ui } = await import('$lib/stores/ui.svelte.js');
const { world } = await import('$lib/stores/world.svelte.js');

/** Put runs on the session frame, which is where the Runs badge reads them from. */
const giveRuns = (runs: unknown[]) => {
  world.sessionHalf = { sessions: [], servers: {}, runs } as never;
};
const run = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  name: 'test:unit',
  repo: 'api',
  worktreePath: '/wt',
  cmd: 'npm run test:unit',
  status: 'passed',
  startedAt: 1,
  endedAt: 2,
  log: '/l',
  ...over,
});

const session = (over: Record<string, unknown> = {}): Session =>
  ({
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
  }) as unknown as Session;

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
    // Changes / Logs / Runs — views of the session, owning no process. (Insights used to
    // be here too, scoped to the session, and a fleet-wide view of the same name lived
    // behind ⌘\; neither exists now.)
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
    expect(screen.queryByRole('tab', { name: /Logs/ })).not.toBeInTheDocument();
  });

  it('has no Insights tab — the cost view is gone and the index line lives in ⌘⇧F', () => {
    render(TabStrip, { session: session() });
    expect(screen.queryByRole('tab', { name: /Insights/ })).not.toBeInTheDocument();
  });

  /*
   * The Runs badge answers two different questions, and only one of them is a count.
   *
   * While something runs, "how many" is what you want. Once it ends, the count vanishes —
   * which tells you a suite finished but not whether it PASSED, the only thing you were
   * waiting for. So the badge outlives the run and carries the outcome.
   */
  it('counts runs in flight', () => {
    giveRuns([run({ status: 'running', endedAt: undefined })]);
    render(TabStrip, { session: session() });
    const tab = screen.getByRole('tab', { name: /Runs/ });
    expect(tab.textContent).toContain('1');
  });

  it('keeps a mark after the last run FAILED — "it finished" is not the answer', () => {
    giveRuns([run({ status: 'failed', exitCode: 1 })]);
    render(TabStrip, { session: session() });
    expect(screen.getByRole('tab', { name: /Runs/ })).toHaveAttribute('title', 'The last run failed');
  });

  it('says nothing when the last run passed — a badge on every tab forever is noise', () => {
    giveRuns([run({ status: 'passed' })]);
    render(TabStrip, { session: session() });
    const tab = screen.getByRole('tab', { name: /Runs/ });
    expect(tab.querySelector('.cbadge')).toBeNull();
  });

  it('ignores runs belonging to another worktree', () => {
    giveRuns([run({ status: 'failed', worktreePath: '/somewhere-else' })]);
    render(TabStrip, { session: session() });
    expect(screen.getByRole('tab', { name: /Runs/ }).querySelector('.cbadge')).toBeNull();
  });

  it('a live run outranks an older failure — the count is the more urgent fact', () => {
    giveRuns([run({ id: 'r2', status: 'running', endedAt: undefined }), run({ status: 'failed' })]);
    render(TabStrip, { session: session() });
    const badge = screen.getByRole('tab', { name: /Runs/ }).querySelector('.cbadge');
    expect(badge?.className).toContain('live');
    expect(badge?.textContent).toBe('1');
  });

  /*
   * The status dot used to sit on EVERY tab, showing the session's real state on the
   * selected one and a hardcoded `idle` on all the others. So an agent that was working
   * looked idle from any tab but its own — backwards, because the tab you are NOT looking
   * at is exactly where you need to be told the agent wants you.
   */
  it('shows the agent state on the agent tab even when another tab is selected', () => {
    const s = session({
      state: 'waiting',
      agentTabId: '@1',
      tabs: [
        { id: '@1', title: 'claude' },
        { id: '@7', title: 'test:unit' },
      ],
    });
    ui.activeTabId = '@7'; // reading a test run, not the agent
    render(TabStrip, { session: s });

    const agentTab = document.querySelector('[data-tab="@1"]');
    const otherTab = document.querySelector('[data-tab="@7"]');
    expect(agentTab?.querySelector('.dot')?.className).toContain('waiting');
    expect(agentTab?.getAttribute('aria-selected')).toBe('false');
    expect(otherTab?.querySelector('.dot')).toBeNull();
  });

  it('never claims idle for a session that is working', () => {
    const s = session({
      state: 'working',
      agentTabId: '@1',
      tabs: [
        { id: '@1', title: 'claude' },
        { id: '@7', title: 'shell' },
      ],
    });
    ui.activeTabId = '@7';
    render(TabStrip, { session: s });
    expect(document.querySelectorAll('.dot.idle')).toHaveLength(0);
  });

  it('falls back to the claude tab for a session recorded before agentTabId existed', () => {
    const s = session({
      state: 'working',
      agentTabId: undefined,
      tabs: [
        { id: '@7', title: 'shell' },
        { id: '@1', title: 'claude' },
      ],
    });
    render(TabStrip, { session: s });
    expect(document.querySelector('[data-tab="@1"]')?.querySelector('.dot')?.className).toContain('working');
    expect(document.querySelector('[data-tab="@7"]')?.querySelector('.dot')).toBeNull();
  });
});
