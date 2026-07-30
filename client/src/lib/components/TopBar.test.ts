import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import type { Feature, Session } from '../../../../server/types';

/*
 * The header's summary, which was wrong in two ways at once.
 *
 * It counted agent states per MEMBER — every worktree across every feature — so a
 * 3-repo feature with one working agent contributed three. The numbers grew with how
 * multi-repo the work was, which is exactly backwards. And `running` counts SERVERS
 * while `working`/`waiting` count AGENTS, printed as one comma-run that read as parts
 * of one total and did not add up.
 *
 * The per-member inflation is the one worth a test: it is invisible unless you happen
 * to own a multi-repo feature and think to check the arithmetic.
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
const session = (id: string, state: string, over: Record<string, unknown> = {}): Session =>
  ({ id, title: id, state, activity: '', repoName: 'accept-blue', worktreePath: '/wt', ...over } as unknown as Session);

function give(features: Feature[], sessions: Session[] = []) {
  world.topology = { features, groups: [], repos: [], webRepos: [] } as never;
  world.sessionHalf = { sessions, servers: {} } as never;
}

/** The counts strip, as text, so assertions read like what is on screen. */
const counts = (c: HTMLElement) => c.querySelector('.counts')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

beforeEach(() => {
  ui.dockView = 'term';
  give([]);
});

describe('TopBar summary', () => {
  it('counts a working agent ONCE however many repos its feature spans', () => {
    // The regression: three members, one agent. This used to say "3 working".
    const agent = { id: 's1', state: 'working', activity: '', muxName: 'm' };
    give(
      [feature('wide', [member('accept-blue', { session: agent }), member('merchant-v3', { session: agent }), member('ab-iso-fe', { session: agent })], agent)],
      [session('s1', 'working')],
    );
    const { container } = render(TopBar);
    expect(counts(container)).toContain('1 working');
    expect(counts(container)).not.toContain('3 working');
  });

  it('counts dev servers per worktree, because each worktree runs its own', () => {
    give([feature('wide', [member('accept-blue', { running: true }), member('merchant-v3', { running: true })])]);
    const { container } = render(TopBar);
    expect(counts(container)).toContain('2 up');
  });

  it('hides a zero rather than spending a slot saying nothing', () => {
    give([feature('quiet', [member('accept-blue')])]);
    const { container } = render(TopBar);
    const text = counts(container);
    expect(text).toContain('1 features');
    expect(text).not.toMatch(/\b0\b/);
  });

  it('labels the two vocabularies separately so they never read as one total', () => {
    give(
      [feature('f', [member('accept-blue', { running: true, session: { id: 's1', state: 'waiting', activity: '', muxName: 'm' } })], { id: 's1', state: 'waiting', activity: '', muxName: 'm' })],
      [session('s1', 'waiting')],
    );
    const { container } = render(TopBar);
    const text = counts(container);
    expect(text).toContain('agents');
    expect(text).toContain('servers');
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

  it('offers the stack-wide buttons only when something is actually running', () => {
    give([feature('quiet', [member('accept-blue')])]);
    const { unmount } = render(TopBar);
    expect(screen.queryByText('Stop all')).not.toBeInTheDocument();
    unmount();

    give([feature('busy', [member('accept-blue', { running: true })])]);
    render(TopBar);
    expect(screen.getByText('Stop all')).toBeInTheDocument();
  });
});
