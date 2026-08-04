import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import type { Feature, Session } from '../../../../server/types';

/*
 * The header is three things now: brand, Insights (with the waiting badge), and the ⋮
 * menu. Everything else moved — New session and the fleet counts to the rail, the rest
 * behind the menu — so what is left to pin here is that the header stays EMPTY of them.
 *
 * The counting rules (per-agent, not per-member; two vocabularies said separately) are
 * tested where they now render: Rail.test.ts.
 */
vi.mock('$lib/ops.svelte.js', () => ({ restartStack: vi.fn(), stopStack: vi.fn() }));

const { default: TopBar } = await import('./TopBar.svelte');
const { ui } = await import('$lib/stores/ui.svelte.js');
const { world } = await import('$lib/stores/world.svelte.js');

const member = (repo: string, over: Record<string, unknown> = {}) => ({
  repo, wtname: 'wt', path: `/${repo}/wt`, branch: 'feature/x',
  running: false, canStart: true, ports: [], isMain: false, session: null, ...over,
});
const feature = (name: string, members: unknown[], session: unknown = null): Feature =>
  ({ name, auto: true, members, session } as unknown as Feature);
const _session = (id: string, state: string, over: Record<string, unknown> = {}): Session =>
  ({ id, title: id, state, activity: '', repoName: 'accept-blue', worktreePath: '/wt', ...over } as unknown as Session);

function give(features: Feature[], sessions: Session[] = []) {
  world.topology = { features, groups: [], repos: [], webRepos: [] } as never;
  world.sessionHalf = { sessions, servers: {} } as never;
}

beforeEach(() => {
  ui.dockView = 'term';
  give([]);
});

describe('TopBar summary', () => {




  it('no longer carries the fleet counts — they live beside the rows they count', () => {
    give([feature('f', [member('accept-blue', { running: true })])]);
    const { container } = render(TopBar);
    expect(container.querySelector('.counts')).toBeNull();
  });

  it('no longer carries New session — it heads the rail it creates rows in', () => {
    render(TopBar);
    expect(screen.queryByText(/New session/)).not.toBeInTheDocument();
  });

  it('puts the rare and the destructive behind one ⋮ rather than in the bar', () => {
    give([feature('f', [member('accept-blue', { running: true })])]);
    render(TopBar);
    // Settings, theme and Stop all were permanent buttons competing with the content.
    expect(screen.queryByLabelText('Toggle theme')).not.toBeInTheDocument();
    expect(screen.queryByText('Stop all')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Menu')).toBeInTheDocument();
  });

  it('does not advertise mux: tmux — it is the only driver and it was noise', () => {
    give([]);
    render(TopBar);
    expect(screen.queryByText(/mux:/)).not.toBeInTheDocument();
  });

  it('offers Insights, and no Overview — that view was the rail drawn wide', () => {
    render(TopBar);
    expect(screen.getByRole('button', { name: /Insights/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Overview/ })).not.toBeInTheDocument();
  });

  it('carries the waiting count as an attention badge on Insights', () => {
    // notify.waitingCount is fed by the stream diff, not by this component, so the
    // badge is asserted as present-and-zero rather than driven here.
    render(TopBar);
    expect(screen.getByRole('button', { name: /Insights/ })).toHaveAttribute('data-n');
  });

  it('offers the stack-wide verbs in the menu only when something is actually running', async () => {
    give([feature('quiet', [member('accept-blue')])]);
    const { unmount } = render(TopBar);
    screen.getByLabelText('Menu').click();
    expect(screen.queryByText(/Stop all servers/)).not.toBeInTheDocument();
    unmount();

    give([feature('busy', [member('accept-blue', { running: true })])]);
    render(TopBar);
    screen.getByLabelText('Menu').click();
    expect(await screen.findByText(/Stop all servers/)).toBeInTheDocument();
  });
});
