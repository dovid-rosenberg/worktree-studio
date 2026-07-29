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
  openApp: vi.fn(), stopMainServer: vi.fn(), promote: vi.fn(),
  activateSession: vi.fn(), closeSession: vi.fn(), pending: new Set(),
}));

const { default: Rail } = await import('./Rail.svelte');
const { ui } = await import('$lib/stores/ui.svelte.js');
const { world } = await import('$lib/stores/world.svelte.js');

const member = (repo: string, over: Record<string, unknown> = {}) => ({
  repo, wtname: 'wt', path: `/${repo}/wt`, branch: 'feature/x',
  running: false, canStart: true, ports: [], isMain: false, session: null, ...over,
});
const feature = (name: string, over: Record<string, unknown> = {}): Feature =>
  ({ name, auto: true, members: [member('accept-blue')], session: null, ...over } as unknown as Feature);
const session = (id: string, over: Record<string, unknown> = {}): Session =>
  ({ id, title: id, state: 'idle', activity: '', repoName: 'accept-blue', worktreePath: null, repos: [], ...over } as unknown as Session);

function give(features: Feature[], sessions: Session[] = [], repos: unknown[] = [], webRepos: string[] = []) {
  world.topology = { features, groups: [], repos, webRepos } as never;
  world.sessionHalf = { sessions, servers: {} } as never;
}

beforeEach(() => {
  ui.repoFilter = '';
  ui.selectedId = null;
  ui.selectedFeatureName = null;
  give([]);
});

describe('Rail', () => {
  it('says what to do when there is nothing yet', () => {
    render(Rail);
    expect(screen.getByText(/Nothing here yet/)).toBeInTheDocument();
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
});
