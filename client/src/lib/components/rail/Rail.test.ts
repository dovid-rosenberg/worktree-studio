import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import type { Feature, Session } from '../../../../../server/types';

/*
 * The rail as composed, rather than the model behind it (stores/ui.test.ts covers that).
 *
 * What this pins is the shape the user actually complained about: no feature drawn
 * twice, no per-kind section headers, one divider where the quiet rows start, and a
 * footer that counts what is on screen rather than one category of it.
 */
vi.mock('$lib/ops.svelte.js', () => ({
  openApp: vi.fn(),
  stopMainServer: vi.fn(),
  promote: vi.fn(),
  activateSession: vi.fn(),
  closeSession: vi.fn(),
  pending: new Set(),
}));

/** The footer summary, as text, so assertions read like what is on screen. */
const foot = (c: HTMLElement) =>
  c.querySelector('.rail-foot')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

const { default: Rail } = await import('./Rail.svelte');
const { ui } = await import('$lib/stores/ui.svelte.js');
const { world } = await import('$lib/stores/world.svelte.js');

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
const feature = (name: string, over: Record<string, unknown> = {}): Feature =>
  ({ name, auto: true, members: [member('accept-blue')], session: null, ...over }) as unknown as Feature;
const session = (id: string, over: Record<string, unknown> = {}): Session =>
  ({
    id,
    title: id,
    state: 'idle',
    activity: '',
    repoName: 'accept-blue',
    worktreePath: null,
    repos: [],
    ...over,
  }) as unknown as Session;

function give(features: Feature[], sessions: Session[] = [], repos: unknown[] = [], webRepos: string[] = []) {
  world.topology = { features, groups: [], repos, webRepos } as never;
  world.sessionHalf = { sessions, servers: {} } as never;
}

beforeEach(() => {
  ui.repoFilter = '';
  ui.clearSelection();
  give([]);
});

describe('Rail', () => {
  /*
   * Two empty states, because they have two different fixes.
   *
   * `baseDirs` defaults to `~/code`, which its own comment calls "a guess, not a
   * convention" — so a first run on any other layout finds zero repos. Telling THAT user
   * to "start a session" walks them into an empty repo dropdown and an `unknown repo ''`,
   * with nothing anywhere naming the real cause.
   */
  it('when there are no REPOS, names the actual problem and offers the fix', () => {
    give([], [], []); // nothing scanned — the first-run state
    render(Rail);
    expect(screen.getByText(/No repositories found/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing here yet/)).not.toBeInTheDocument();
  });

  it('with repos but no work, says what to do next', () => {
    give([], [], [{ name: 'accept-blue', path: '/code/accept-blue', worktrees: [] }]);
    render(Rail);
    expect(screen.getByText(/Nothing here yet/)).toBeInTheDocument();
    expect(screen.queryByText(/No repositories found/)).not.toBeInTheDocument();
  });

  it('draws a running feature ONCE — the duplication that started all this', () => {
    give([feature('busy', { members: [member('accept-blue', { running: true })] })]);
    render(Rail);
    expect(screen.getAllByRole('button', { name: /Select feature busy/ })).toHaveLength(1);
  });

  it('has no per-kind section headers', () => {
    give([feature('a')], [session('s1')]);
    render(Rail);
    for (const gone of [/Servers running/i, /Agents · no worktree/i, /^Worktrees/i]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
  });

  it('marks where the quiet rows begin, once, with a count', () => {
    give([
      feature('busy', { members: [member('accept-blue', { running: true })] }),
      feature('quiet-a'),
      feature('quiet-b'),
    ]);
    const { container } = render(Rail);
    const dividers = container.querySelectorAll('.divider');
    expect(dividers).toHaveLength(1);
    expect(dividers[0].textContent).toContain('idle · 2');
  });

  it('draws no divider when everything is active', () => {
    give([feature('busy', { members: [member('accept-blue', { running: true })] })]);
    const { container } = render(Rail);
    expect(container.querySelector('.divider')).toBeNull();
  });

  it('puts a sessionless feature and an agent in the same list', () => {
    give([feature('bare')], [session('s1', { title: 'unpromoted agent' })]);
    render(Rail);
    expect(screen.getByRole('button', { name: /Select feature bare/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Select session unpromoted agent/ })).toBeInTheDocument();
  });

  it('counts the rows it drew, not one category of them', () => {
    // The footer used to say "N feature(s)" while the list also held agents and
    // main-checkout servers, so the number never matched what was on screen.
    give([feature('a'), feature('b')], [session('s1')]);
    const { container } = render(Rail);
    expect(container.querySelector('.rail-foot')?.textContent).toContain('3 row(s)');
  });

  it('offers every member repo in the filter, not just the ones with sessions', () => {
    give([feature('x', { members: [member('accept-blue'), member('merchant-v3')] })]);
    render(Rail);
    const select = screen.getByLabelText('Filter by repo') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'accept-blue', 'merchant-v3']);
  });

  /*
   * The fleet summary moved down from the header to sit beside the rows it counts. Both
   * counting rules came with it, and both were bugs once:
   *
   *  - agent states were counted per MEMBER, so a 3-repo feature with one working agent
   *    said "3 working" — the numbers grew with how multi-repo the work was;
   *  - `running` counts SERVERS while working/waiting count AGENTS, and printed as one
   *    comma-run they read as parts of a total that never added up.
   */
  it('counts a working agent ONCE however many repos its feature spans', () => {
    const agent = { id: 's1', state: 'working', activity: '', muxName: 'm' };
    give(
      [
        feature('wide', {
          members: [member('accept-blue', { session: agent }), member('merchant-v3', { session: agent })],
          session: agent,
        }),
      ],
      [session('s1', { state: 'working', worktreePath: '/wt' })],
    );
    const { container } = render(Rail);
    expect(foot(container)).toContain('1 working');
    expect(foot(container)).not.toContain('2 working');
  });

  it('counts dev servers per worktree, because each worktree runs its own', () => {
    give([
      feature('wide', {
        members: [member('accept-blue', { running: true }), member('merchant-v3', { running: true })],
      }),
    ]);
    const { container } = render(Rail);
    expect(foot(container)).toContain('2 up');
  });

  it('hides a zero rather than spending a slot saying nothing', () => {
    give([feature('quiet')]);
    const { container } = render(Rail);
    expect(foot(container)).not.toMatch(/\b0 (working|waiting|up)\b/);
  });

  it('heads the list with New session — the verb that creates what it lists', () => {
    give([]);
    render(Rail);
    expect(screen.getByRole('button', { name: /New session/ })).toBeInTheDocument();
  });

  it('carries the fleet-wide controls above that, rather than a bar across the window', () => {
    /*
     * The scope split is already drawn down the middle of the screen: the rail is the
     * FLEET, the dock is ONE FEATURE. Insights, the waiting jump and the ⋮ menu are all
     * fleet-wide, so they belong on this side of it — as a full-width header they were a
     * third horizontal stripe sitting directly above a bar that acts on one selection,
     * with nothing but a divider to say which was which.
     *
     * Rendered as part of Rail and not a peer of it, so this test would fail if AppHead
     * were ever hoisted back out to +page.svelte.
     */
    give([]);
    render(Rail);
    expect(screen.getByRole('button', { name: 'Insights' })).toBeInTheDocument();
    expect(screen.getByLabelText('Menu')).toBeInTheDocument();
  });
});
