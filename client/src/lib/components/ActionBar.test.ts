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
const ops = vi.hoisted(() =>
  Object.fromEntries(
    [
      'activateSession',
      'addRepoToSession',
      'closeFeature',
      'closeSession',
      'deactivateSession',
      'deleteFeature',
      'installDeps',
      'openEditor',
      'openGroup',
      'openSessionRepos',
      'prFeature',
      'promote',
      'renameSession',
      'restartStack',
      'runStack',
      'startFeatureSession',
      'stopMainServer',
      'stopStack',
    ].map((k) => [k, vi.fn()]),
  ),
);
vi.mock('$lib/ops.svelte.js', () => ({ ...ops, pending: new Set() }));
// The Run menu fetches on open; the bar's own tests are about which verbs it offers.
vi.mock('$lib/components/RunConfigMenu.svelte', () => ({ default: (() => {}) as never }));

const { default: ActionBar } = await import('./ActionBar.svelte');
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

const feature = (over: Record<string, unknown> = {}): Feature =>
  ({
    name: 'token-race-fix',
    auto: true,
    members: [member('accept-blue')],
    session: null,
    ...over,
  }) as unknown as Feature;

/** One entry of a session's `repos` — the worktrees the agent can actually write to. */
const sessionRepo = (repo: string, over: Record<string, unknown> = {}) => ({
  repo,
  repoPath: `/${repo}`,
  worktree: 'wt',
  worktreePath: `/${repo}/wt`,
  branch: 'fix/x',
  ...over,
});

// `repos` is always present on the wire (server/types.ts declares it required), so the
// fixture carries it: the bar reads it to decide how many worktrees "Open in editor"
// has to open, and a fixture without it tests a session shape the server never sends.
const session = (over: Record<string, unknown> = {}): Session =>
  ({
    id: 's1',
    title: 'token-race-fix',
    state: 'working',
    repoName: 'accept-blue',
    worktreePath: '/wt',
    branch: 'fix/x',
    feature: 'token-race-fix',
    active: true,
    repos: [sessionRepo('accept-blue', { primary: true })],
    ...over,
  }) as unknown as Session;

function give(features: Feature[], sessions: Session[]) {
  world.topology = { features, groups: [], repos: [], webRepos: [] } as never;
  world.sessionHalf = { sessions, servers: {} } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  ui.clearSelection();
  ui.repoFilter = '';
  give([], []);
});

describe('ActionBar', () => {
  it('prompts rather than sitting empty when nothing is selected', () => {
    render(ActionBar);
    expect(screen.getByText(/Select a feature, session or server/)).toBeInTheDocument();
  });

  it('offers exactly one verb for starting dev servers', () => {
    give([feature()], [session()]);
    ui.select('s1');
    render(ActionBar);
    expect(screen.getByText('Run stack')).toBeInTheDocument();
    // The duplicate that started the same worktrees by the weaker route.
    expect(screen.queryByText('Run servers')).not.toBeInTheDocument();
    expect(screen.queryByText('Stop servers')).not.toBeInTheDocument();
  });

  it('shows stack verbs for a selected SESSION by resolving its feature', () => {
    give([feature({ members: [member('accept-blue', { running: true })] })], [session()]);
    ui.select('s1');
    render(ActionBar);
    screen.getByText('Stop stack').click();
    expect(ops.stopStack).toHaveBeenCalledWith('token-race-fix');
  });

  it('offers Promote, not Open in editor, before there is a worktree', () => {
    give([], [session({ worktreePath: null, feature: null })]);
    ui.select('s1');
    render(ActionBar);
    expect(screen.getByText(/Promote to worktree/)).toBeInTheDocument();
    expect(screen.queryByText('Open in editor')).not.toBeInTheDocument();
  });

  /*
   * The bug: the button called `openEditor(session.worktreePath)` — the PRIMARY worktree
   * alone — so a BE+FE feature opened the BE and silently left the FE behind. A feature
   * is several repos by definition, which makes "open one of them" the wrong default.
   */
  it('opens every repo the session spans, not just the primary one', async () => {
    const s = session({
      repos: [sessionRepo('accept-blue', { primary: true }), sessionRepo('ab-iso-fe')],
    });
    give([], [s]);
    ui.select('s1');
    render(ActionBar);
    // The count is on the button, so a two-repo feature says so before it is clicked.
    screen.getByText(/Open in editor \(2\)/).click();
    expect(ops.openSessionRepos).toHaveBeenCalledWith(s);
  });

  it('does not count-label a single-repo session', () => {
    give([], [session()]);
    ui.select('s1');
    render(ActionBar);
    expect(screen.getByText('Open in editor')).toBeInTheDocument();
  });

  /*
   * MainServerCard used to carry Open ↗ and Stop itself — the only buttons in the rail,
   * and an admitted exception to the rule that the rail never has any. The row could not
   * be selected, so the bar had nothing to act on. It is a selection kind now.
   */
  it('acts on a main-checkout server, whose card no longer carries its own buttons', () => {
    world.topology = {
      features: [],
      groups: [],
      webRepos: [],
      repos: [
        {
          name: 'ab-su',
          path: '/ab-su',
          worktrees: [{ repo: 'ab-su', path: '/ab-su', isMain: true, running: true, ports: [8000] }],
        },
      ],
    } as never;
    world.sessionHalf = { sessions: [], servers: {} } as never;
    ui.selectMainServer('/ab-su');
    render(ActionBar);
    expect(screen.getByText('Open ab-su ↗')).toBeInTheDocument();
    screen.getByText('Stop server').click();
    expect(ops.stopMainServer).toHaveBeenCalled();
  });

  it('offers Resume for a deactivated session and Deactivate for a live one', () => {
    give([], [session({ active: false })]);
    ui.select('s1');
    const { unmount } = render(ActionBar);
    expect(screen.getByText(/Resume/)).toBeInTheDocument();
    unmount();

    give([], [session({ active: true })]);
    render(ActionBar);
    expect(screen.getByText('Deactivate')).toBeInTheDocument();
  });

  it('gives a sessionless feature its own verbs, starting with the one that matters', () => {
    give([feature()], []);
    ui.selectFeature({ name: 'token-race-fix' } as never);
    render(ActionBar);
    expect(screen.getByText('Start session')).toBeInTheDocument();
    // CREATE, not "Open" — the pill in the dock opens one in a browser, and the same
    // four words for two different actions is a trap you fall into once a week.
    expect(screen.getByText('Create PR / MR')).toBeInTheDocument();
    // Session-only verbs must not appear for something with no session.
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Delete session')).not.toBeInTheDocument();
  });

  /*
   * The bar used to open with the selection's name and branch. DockHead already shows
   * both for a session, and FeaturePane's heading shows the name for a feature — three
   * readouts of one selection stacked down the screen. The bar is buttons now.
   */
  it('does not name what it is acting on — the dock header does that', () => {
    give([feature()], [session()]);
    ui.select('s1');
    const { container } = render(ActionBar);
    expect(container.querySelector('.who')).toBeNull();
    // Still acting on the right thing, which is the part that matters.
    screen.getByText('Run stack').click();
    expect(ops.runStack).toHaveBeenCalledWith('token-race-fix');
  });
});
