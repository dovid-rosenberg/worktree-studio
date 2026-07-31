import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import type { Feature, Session } from '../../../../../server/types';

/*
 * The dock's routing — which of five surfaces it shows, and in what precedence.
 *
 * The order is the whole content of this file, because getting it wrong is invisible
 * in the code and obvious on screen. `feature` is tested BEFORE `session`, and that
 * ordering is what made "Start session here" appear to do nothing: the op set
 * selectedId without clearing selectedFeatureName, so the feature branch still won and
 * the user kept staring at a table while the ActionBar — which tests session first —
 * had already switched to session verbs.
 *
 * The terminal is stubbed. It opens a WebSocket and drives xterm against a real canvas;
 * neither belongs in a routing test, and both are covered by the smoke suite booting a
 * real daemon.
 */
vi.mock('$lib/components/Terminal.svelte', () => ({ default: (() => {}) as never }));
vi.mock('$lib/components/dock/SplitPane.svelte', () => ({ default: (() => {}) as never }));
vi.mock('$lib/components/dock/ReviewMount.svelte', () => ({ default: (() => {}) as never }));
vi.mock('$lib/components/dock/InsightsMount.svelte', () => ({ default: (() => {}) as never }));
vi.mock('$lib/components/dock/LogsPanel.svelte', () => ({ default: (() => {}) as never }));
vi.mock('$lib/components/insights/FleetInsights.svelte', () => ({ default: (() => {}) as never }));
vi.mock('$lib/api.js', () => ({ api: vi.fn().mockResolvedValue({ repos: [] }), TOKEN: '', tokenQuery: () => '' }));
vi.mock('$lib/ops.svelte.js', () => ({
  addTab: vi.fn(), closeTab: vi.fn(), renameTab: vi.fn(), selectTab: vi.fn(),
  startSessionServers: vi.fn(), stopSessionServers: vi.fn(), pending: new Set(),
}));

const { default: Dock } = await import('./Dock.svelte');
const { ui } = await import('$lib/stores/ui.svelte.js');
const { world } = await import('$lib/stores/world.svelte.js');

const member = (repo: string) => ({
  repo, wtname: 'wt', path: `/${repo}/wt`, branch: 'feature/x',
  running: false, canStart: true, ports: [], isMain: false, session: null,
});
const feature = (name = 'bare'): Feature =>
  ({ name, auto: true, members: [member('accept-blue')], session: null } as unknown as Feature);
const session = (id = 's1'): Session =>
  ({ id, title: 'token-race-fix', state: 'working', activity: '', repoName: 'accept-blue',
     worktreePath: '/wt', branch: 'fix/x', feature: 'token-race-fix', repos: [], tabs: [],
     source: 'freetext', active: true } as unknown as Session);

function give(features: Feature[] = [], sessions: Session[] = []) {
  world.topology = { features, groups: [], repos: [], webRepos: [] } as never;
  world.sessionHalf = { sessions, servers: {} } as never;
}

beforeEach(() => {
  ui.dockView = 'term';
  ui.selectedId = null;
  ui.selectedFeatureName = null;
  ui.repoFilter = '';
  give();
});

describe('Dock routing', () => {
  it('invites you to start something when nothing is selected', () => {
    render(Dock);
    expect(screen.getByText('No session selected')).toBeInTheDocument();
    // Insights is reachable from the empty state: it is about every session that ever
    // ran, so it is exactly what you might want with nothing selected.
    expect(screen.getByText(/Insights/)).toBeInTheDocument();
  });

  it('says a session is STARTING rather than that none is selected', () => {
    // Selection happens when the create call returns; the session arrives with the next
    // SSE frame. Calling that window "no session selected" is what made starting an
    // agent look like a no-op and sent people clicking the rail to fix it.
    ui.selectedId = 'not-here-yet';
    render(Dock);
    expect(screen.getByText('Starting the session…')).toBeInTheDocument();
    expect(screen.queryByText('No session selected')).not.toBeInTheDocument();
  });

  it('shows the feature pane for a feature with no agent', () => {
    give([feature()]);
    ui.selectedFeatureName = 'bare';
    render(Dock);
    expect(screen.getByRole('heading', { name: 'bare' })).toBeInTheDocument();
  });

  it('shows the session surface once the session lands', () => {
    give([], [session()]);
    ui.selectedId = 's1';
    const { container } = render(Dock);
    expect(container.querySelector('.dock-head')).toBeTruthy();
    expect(container.querySelector('.tabstrip')).toBeTruthy();
    expect(screen.queryByText('No session selected')).not.toBeInTheDocument();
  });

  it('lets Insights win over any selection — it is about the fleet, not the row', () => {
    give([], [session()]);
    ui.selectedId = 's1';
    ui.dockView = 'usage';
    const { container } = render(Dock);
    // The session surface must not be underneath it.
    expect(container.querySelector('.dock-head')).toBeNull();
  });

  it('prefers the feature branch over the session branch — the precedence that bit', () => {
    // If both fields are ever set, the feature wins. That is why selecting a session
    // MUST clear selectedFeatureName, and why ui.select() exists rather than a bare
    // assignment. Pinning the precedence makes the invariant's importance explicit.
    give([feature()], [session()]);
    ui.selectedFeatureName = 'bare';
    ui.selectedId = 's1';
    const { container } = render(Dock);
    expect(screen.getByRole('heading', { name: 'bare' })).toBeInTheDocument();
    expect(container.querySelector('.dock-head')).toBeNull();
  });

  it('keeps the server bar with the session, where the ports are', () => {
    give([], [session()]);
    ui.selectedId = 's1';
    const { container } = render(Dock);
    expect(container.querySelector('.serverbar')).toBeTruthy();
  });
});
