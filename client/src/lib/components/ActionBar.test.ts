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
/*
 * The Run menu fetches on open, so it is stubbed — but as a SPY, because where it is
 * mounted is now part of what this bar promises. Svelte 5 mounts a component by calling
 * it, so "was it called" is "was it rendered".
 */
const runMenu = vi.hoisted(() => vi.fn());
vi.mock('$lib/components/RunConfigMenu.svelte', () => ({ default: runMenu as never }));

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
    /*
     * Found by ACCESSIBLE NAME, not by text: the verbs are glyphs in a labelled cluster
     * now, so the name lives in aria-label. That is also the assertion worth making —
     * a glyph with no accessible name is a different bug, and this catches it.
     */
    expect(screen.getByRole('button', { name: 'Start dev servers' })).toBeInTheDocument();
    // The duplicate that started the same worktrees by the weaker route.
    expect(screen.queryByRole('button', { name: /Run servers/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop servers/ })).not.toBeInTheDocument();
    // And the cluster says what those verbs act on.
    expect(screen.getByRole('group', { name: 'Dev servers' })).toBeInTheDocument();
  });

  it('hands ▷ Run… to the Runs tab for a session, and keeps it only where there is no tab', () => {
    /*
     * The menu produces runs, and a run's whole outcome — status, duration, exit code,
     * output — is in the Runs tab. Pressing it from here meant acting in one place and
     * finding out what happened in another, and it cost the bar a third cluster beside
     * `servers` and `agent`.
     *
     * A sessionless feature keeps it, and that is not an inconsistency to tidy away: a
     * run needs only a worktree (`/run-configs/run` never read the sessionId this bar used
     * to send), so a feature CAN run its configs while having no Runs tab to host the
     * button. Deleting this mount would delete the capability with it.
     */
    give([feature()], [session()]);
    ui.select('s1');
    const { unmount } = render(ActionBar);
    expect(runMenu).not.toHaveBeenCalled();
    unmount();

    runMenu.mockClear();
    give([feature()], []);
    ui.selectFeature({ name: 'token-race-fix' } as never);
    render(ActionBar);
    expect(runMenu).toHaveBeenCalled();
  });

  it('shows stack verbs for a selected SESSION by resolving its feature', () => {
    give([feature({ members: [member('accept-blue', { running: true })] })], [session()]);
    ui.select('s1');
    render(ActionBar);
    screen.getByRole('button', { name: 'Stop dev servers' }).click();
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
  /*
   * Open in editor lives in the ⋯ menu now: the bar is split by CONSEQUENCE — reversible
   * verbs pressed constantly on the left, things that change what the feature is on the
   * right — and this one is used rarely enough not to earn permanent width.
   */
  it('opens every repo the session spans, not just the primary one', async () => {
    const s = session({
      repos: [sessionRepo('accept-blue', { primary: true }), sessionRepo('ab-iso-fe')],
    });
    give([], [s]);
    ui.select('s1');
    render(ActionBar);
    screen.getByRole('button', { name: 'More actions' }).click();
    // findBy*, not getBy*: Svelte 5 flushes state on a microtask, so the sheet is not in
    // the DOM on the line after the click.
    // The count is on the item, so a two-repo feature says so before it is clicked.
    (await screen.findByText(/Open in editor \(2\)/)).click();
    expect(ops.openSessionRepos).toHaveBeenCalledWith(s);
  });

  it('does not count-label a single-repo session', async () => {
    give([], [session()]);
    ui.select('s1');
    render(ActionBar);
    screen.getByRole('button', { name: 'More actions' }).click();
    expect(await screen.findByText('Open in editor')).toBeInTheDocument();
  });

  it('the destructive verb is in the menu, under a divider — not loose on the bar', async () => {
    // It used to sit at the end of the row after a thin rule, at the same weight as
    // everything else. A menu with a separator is where destructive verbs belong.
    give([], [session()]);
    ui.select('s1');
    render(ActionBar);
    expect(screen.queryByLabelText('Delete session')).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'More actions' }).click();
    expect(await screen.findByText('Delete session')).toBeInTheDocument();
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

  // Found by NAME, not by glyph: these two are icon-only now, and the accessible name
  // is the whole reason that is allowed. A test that matched the character would pass
  // just as happily with no label on it at all.
  it('offers Resume for a deactivated session and Deactivate for a live one', () => {
    give([], [session({ active: false })]);
    ui.select('s1');
    const { unmount } = render(ActionBar);
    // "agent", not "session": the cluster labels what these act ON, which is what tells
    // ▶ here apart from ▶ in the servers cluster beside it.
    expect(screen.getByLabelText('Resume agent')).toBeInTheDocument();
    expect(screen.queryByLabelText('Pause agent')).not.toBeInTheDocument();
    unmount();

    give([], [session({ active: true })]);
    render(ActionBar);
    expect(screen.getByLabelText('Pause agent')).toBeInTheDocument();
    expect(screen.queryByLabelText('Resume agent')).not.toBeInTheDocument();
    // Restarting the terminal is only meaningful while it is running.
    expect(screen.getByLabelText('Restart terminal')).toBeInTheDocument();
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
    expect(screen.queryByLabelText('Deactivate session')).not.toBeInTheDocument();
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
    screen.getByRole('button', { name: 'Start dev servers' }).click();
    expect(ops.runStack).toHaveBeenCalledWith('token-race-fix');
  });
});
