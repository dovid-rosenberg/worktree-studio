import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import type { Feature, Session } from '../../../../server/types';

/*
 * The bottom bar is now the ONLY place actions live, so these pin two things:
 *
 *   1. it adapts to both selection kinds — a session and a sessionless feature need
 *      the same verbs, the feature simply has fewer of them;
 *   2. ONE VERB PER CONCEPT. `Run servers` used to sit two buttons from `Run stack`
 *      and start the same worktrees by a different route. A `Run servers` reappearing
 *      here is the regression to catch.
 */
const ops = vi.hoisted(() => Object.fromEntries([
  'activateSession', 'addRepoToSession', 'closeFeature', 'closeSession', 'deactivateSession',
  'deleteFeature', 'openEditor', 'openGroup', 'prFeature', 'promote', 'renameSession',
  'restartStack', 'runStack', 'startFeatureSession', 'stopStack',
].map((k) => [k, vi.fn()])));
vi.mock('$lib/ops.svelte.js', () => ({ ...ops, pending: new Set() }));

const { default: ActionBar } = await import('./ActionBar.svelte');
const { ui } = await import('$lib/stores/ui.svelte.js');
const { world } = await import('$lib/stores/world.svelte.js');

const member = (repo: string, over: Record<string, unknown> = {}) => ({
  repo, wtname: 'wt', path: `/${repo}/wt`, branch: 'feature/x',
  running: false, canStart: true, ports: [], isMain: false, session: null, ...over,
});

const feature = (over: Record<string, unknown> = {}): Feature =>
  ({ name: 'token-race-fix', auto: true, members: [member('accept-blue')], session: null, ...over } as unknown as Feature);

const session = (over: Record<string, unknown> = {}): Session =>
  ({ id: 's1', title: 'token-race-fix', state: 'working', repoName: 'accept-blue',
     worktreePath: '/wt', branch: 'fix/x', feature: 'token-race-fix', active: true, ...over } as unknown as Session);

function give(features: Feature[], sessions: Session[]) {
  world.topology = { features, groups: [], repos: [], webRepos: [] } as never;
  world.sessionHalf = { sessions, servers: {} } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  ui.selectedId = null;
  ui.selectedFeatureName = null;
  ui.repoFilter = '';
  give([], []);
});

describe('ActionBar', () => {
  it('prompts rather than sitting empty when nothing is selected', () => {
    render(ActionBar);
    expect(screen.getByText(/Select a feature or agent/)).toBeInTheDocument();
  });

  it('offers exactly one verb for starting dev servers', () => {
    give([feature()], [session()]);
    ui.selectedId = 's1';
    render(ActionBar);
    expect(screen.getByText('Run stack')).toBeInTheDocument();
    // The duplicate that started the same worktrees by the weaker route.
    expect(screen.queryByText('Run servers')).not.toBeInTheDocument();
    expect(screen.queryByText('Stop servers')).not.toBeInTheDocument();
  });

  it('shows stack verbs for a selected SESSION by resolving its feature', () => {
    give([feature({ members: [member('accept-blue', { running: true })] })], [session()]);
    ui.selectedId = 's1';
    render(ActionBar);
    screen.getByText('Stop stack').click();
    expect(ops.stopStack).toHaveBeenCalledWith('token-race-fix');
  });

  it('offers Promote, not Open in editor, before there is a worktree', () => {
    give([], [session({ worktreePath: null, feature: null })]);
    ui.selectedId = 's1';
    render(ActionBar);
    expect(screen.getByText(/Promote to worktree/)).toBeInTheDocument();
    expect(screen.queryByText('Open in editor')).not.toBeInTheDocument();
  });

  it('offers Resume for a deactivated session and Deactivate for a live one', () => {
    give([], [session({ active: false })]);
    ui.selectedId = 's1';
    const { unmount } = render(ActionBar);
    expect(screen.getByText(/Resume/)).toBeInTheDocument();
    unmount();

    give([], [session({ active: true })]);
    render(ActionBar);
    expect(screen.getByText('Deactivate')).toBeInTheDocument();
  });

  it('gives a sessionless feature its own verbs, starting with the one that matters', () => {
    give([feature()], []);
    ui.selectedFeatureName = 'token-race-fix';
    render(ActionBar);
    expect(screen.getByText('Start session here')).toBeInTheDocument();
    expect(screen.getByText('Open PR / MR')).toBeInTheDocument();
    // Session-only verbs must not appear for something with no session.
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Delete session')).not.toBeInTheDocument();
  });

  it('names what it is acting on, so the bar is never ambiguous', () => {
    give([feature()], [session()]);
    ui.selectedId = 's1';
    const { container } = render(ActionBar);
    expect(container.querySelector('.who .nm')?.textContent).toBe('token-race-fix');
    expect(container.querySelector('.who .sb')?.textContent).toContain('fix/x');
  });
});
