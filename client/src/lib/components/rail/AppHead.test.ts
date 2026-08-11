import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import type { Feature, Session } from '../../../../../server/types';

/*
 * The app header is four things: brand, the waiting button, Insights and the ⋮ menu.
 * Everything else moved — New session and the fleet counts to the rail below it, the rest
 * behind the menu — so what is pinned here is that the header stays EMPTY of them.
 *
 * Since it moved into a 212px rail column, two of its controls are glyph-only. That makes
 * their ACCESSIBLE NAMES load-bearing rather than decorative: `◔` and `◉ 3` say nothing to
 * a screen reader, and nothing to anyone who has not learnt them, so every test below
 * queries by name and would fail if a label were dropped along with the visible word.
 *
 * The counting rules (per-agent, not per-member; two vocabularies said separately) are
 * tested where they now render: Rail.test.ts.
 */
vi.mock('$lib/ops.svelte.js', () => ({ restartStack: vi.fn(), stopStack: vi.fn() }));

const { default: AppHead } = await import('./AppHead.svelte');
const { ui } = await import('$lib/stores/ui.svelte.js');
const { world } = await import('$lib/stores/world.svelte.js');
// Set imperatively by notify.observe() as frames land, so tests set it directly rather
// than trying to drive it through the world halves.
const { notify } = await import('$lib/stores/notify.svelte.js');

const member = (repo: string, over: Record<string, unknown> = {}) => ({
  repo,
  wtname: 'wt',
  path: `/${repo}/wt`,
  branch: 'feature/x',
  running: false,
  canStart: true,
  ports: [],
  isMain: false,
  session: null,
  ...over,
});
const feature = (name: string, members: unknown[], session: unknown = null): Feature =>
  ({ name, auto: true, members, session }) as unknown as Feature;
const session = (id: string, state: string, over: Record<string, unknown> = {}): Session =>
  ({
    id,
    title: id,
    state,
    activity: '',
    repoName: 'accept-blue',
    worktreePath: '/wt',
    ...over,
  }) as unknown as Session;

function give(features: Feature[], sessions: Session[] = []) {
  world.topology = { features, groups: [], repos: [], webRepos: [] } as never;
  world.sessionHalf = { sessions, servers: {} } as never;
}

beforeEach(() => {
  ui.dockView = 'term';
  notify.waitingCount = 0;
  give([]);
});

describe('AppHead summary', () => {
  it('no longer carries the fleet counts — they live beside the rows they count', () => {
    give([feature('f', [member('accept-blue', { running: true })])]);
    const { container } = render(AppHead);
    expect(container.querySelector('.counts')).toBeNull();
  });

  it('no longer carries New session — it heads the rail it creates rows in', () => {
    render(AppHead);
    expect(screen.queryByText(/New session/)).not.toBeInTheDocument();
  });

  it('puts the rare and the destructive behind one ⋮ rather than in the bar', () => {
    give([feature('f', [member('accept-blue', { running: true })])]);
    render(AppHead);
    // Settings, theme and Stop all were permanent buttons competing with the content.
    expect(screen.queryByLabelText('Toggle theme')).not.toBeInTheDocument();
    expect(screen.queryByText('Stop all')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Menu')).toBeInTheDocument();
  });

  it('does not advertise mux: tmux — it is the only driver and it was noise', () => {
    give([]);
    render(AppHead);
    expect(screen.queryByText(/mux:/)).not.toBeInTheDocument();
  });

  it('hands Insights to the ⋮ menu rather than spending head width on it', () => {
    /*
     * A 212px column cannot hold a wordmark, a root switcher and three buttons, and of
     * those the root switcher earns the space: which body of work you are looking at is
     * worth naming on screen all day. Insights is one destination among the menu's
     * actions — AppMenu.test.ts pins that it arrived, including its ⌘\ label, so the
     * two tests together say it moved rather than went.
     */
    render(AppHead);
    expect(screen.queryByRole('button', { name: /Insights/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Menu')).toBeInTheDocument();
  });

  it('never brings back Overview — that view was the rail drawn wide', () => {
    render(AppHead);
    expect(screen.queryByRole('button', { name: /Overview/ })).not.toBeInTheDocument();
  });

  it('shows NO waiting button while nothing is waiting', () => {
    /*
     * The count used to be a badge on Insights, so the one state worth interrupting you
     * for routed you to the usage breakdown — away from the session asking for you. It
     * is its own button now, and an attention control that is always present is not an
     * attention control, so it is absent at zero.
     */
    render(AppHead);
    expect(screen.queryByRole('button', { name: /waiting/i })).not.toBeInTheDocument();
  });

  it('makes the count the waiting button itself, not a badge beside a word', () => {
    /*
     * In the rail, `◉ Waiting` plus a superimposed count badge printed the same number
     * twice and cost width the column does not have. The number IS the label — so it has
     * to be the number, and the button still has to say what pressing it does.
     */
    give(
      [feature('f', [member('accept-blue')])],
      [session('a', 'waiting'), session('b', 'waiting'), session('c', 'working')],
    );
    notify.waitingCount = 2;
    render(AppHead);
    const attn = screen.getByRole('button', { name: /2 session\(s\) waiting/ });
    expect(attn.textContent).toContain('2');
    expect(attn.textContent).not.toContain('Waiting');
  });

  it('offers the stack-wide verbs in the menu only when something is actually running', async () => {
    give([feature('quiet', [member('accept-blue')])]);
    const { unmount } = render(AppHead);
    screen.getByLabelText('Menu').click();
    expect(screen.queryByText(/Stop all servers/)).not.toBeInTheDocument();
    unmount();

    give([feature('busy', [member('accept-blue', { running: true })])]);
    render(AppHead);
    screen.getByLabelText('Menu').click();
    expect(await screen.findByText(/Stop all servers/)).toBeInTheDocument();
  });
});
