import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Session } from '../../../../../server/types';

/*
 * The Runs tab owns the whole activity: pick a configuration, watch it run, read what it
 * said. ▷ Run… used to sit in the action bar, one bar and one tab away from every one of
 * those answers, so these pin that it is HERE and that it is pointed at every worktree the
 * session owns.
 *
 * The menu itself fetches on open, so it is stubbed as a spy — Svelte 5 mounts a component
 * by calling it, and the props it was called with are what this file is really about.
 */
const runMenu = vi.hoisted(() => vi.fn());
vi.mock('$lib/components/RunConfigMenu.svelte', () => ({ default: runMenu as never }));
// Typed with its real arg list: `vi.fn(async () => …)` infers a ZERO-arg function, so
// `.mock.calls` becomes an empty tuple and asserting on the url would not compile.
const apiMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ text: '', offset: 0 }) as Record<string, unknown>),
);
vi.mock('$lib/api.js', () => ({ api: apiMock }));
vi.mock('$lib/stores/toasts.svelte.js', () => ({ toast: vi.fn() }));

const { default: RunsPanel } = await import('./RunsPanel.svelte');
const { world } = await import('$lib/stores/world.svelte.js');

/** One entry of a session's `repos` — a worktree the agent can write to. */
const sessionRepo = (repo: string, over: Record<string, unknown> = {}) => ({
  repo,
  repoPath: `/${repo}`,
  worktree: 'wt',
  worktreePath: `/${repo}/wt`,
  branch: 'fix/x',
  ...over,
});

const session = (over: Record<string, unknown> = {}): Session =>
  ({
    id: 's1',
    title: 'unblock-api-endpoint',
    state: 'working',
    activity: '',
    repoName: 'accept-blue',
    worktreePath: '/accept-blue/wt',
    repos: [sessionRepo('accept-blue', { primary: true })],
    ...over,
  }) as unknown as Session;

/** The `targets` the menu was mounted with, however Svelte passed them along. */
const targetsPassed = (): Array<{ repo: string; path: string }> => {
  const call = runMenu.mock.calls.at(-1) as unknown[] | undefined;
  const props = call?.find(
    (a): a is { targets: Array<{ repo: string; path: string }> } =>
      !!a && typeof a === 'object' && 'targets' in (a as object),
  );
  return props?.targets ?? [];
};

beforeEach(() => {
  vi.clearAllMocks();
  world.topology = { features: [], groups: [], repos: [], webRepos: [] } as never;
  world.sessionHalf = { sessions: [], servers: {}, runs: [] } as never;
});

describe('RunsPanel', () => {
  it('carries ▷ Run… itself rather than sending you to another bar for it', () => {
    render(RunsPanel, { props: { session: session() } });
    expect(runMenu).toHaveBeenCalled();
  });

  it('offers it even with no history — the empty state points AT it, not elsewhere', () => {
    /*
     * The copy used to read "Use ▷ Run in the bar below". A first-time empty state whose
     * only instruction is the name of a control somewhere off-panel is the worst place for
     * that button to be absent.
     */
    render(RunsPanel, { props: { session: session() } });
    expect(screen.getByText(/Nothing has been run here yet/)).toBeInTheDocument();
    expect(runMenu).toHaveBeenCalled();
    expect(screen.queryByText(/in the bar below/)).not.toBeInTheDocument();
  });

  it('points the menu at EVERY worktree the session owns, not just the primary', () => {
    // A BE+FE feature: a menu reading one repo's configs can only reach half the tests.
    render(RunsPanel, {
      props: {
        session: session({
          repos: [
            sessionRepo('accept-blue', { primary: true }),
            sessionRepo('merchant-v3'),
          ],
        }),
      },
    });
    expect(targetsPassed().map((t) => t.repo).sort()).toEqual(['accept-blue', 'merchant-v3']);
  });

  it('names each worktree once when the primary also appears in repos[]', () => {
    /*
     * `session.worktreePath` IS `repos[primary].worktreePath`, so concatenating the two
     * lists without a guard mounts the menu with the same worktree twice — and the menu
     * heads its groups by repo, so it would print a duplicate group and read that repo's
     * config directory twice per open.
     */
    render(RunsPanel, { props: { session: session() } });
    expect(targetsPassed()).toEqual([{ repo: 'accept-blue', path: '/accept-blue/wt' }]);
  });

  it('offers nothing to run before the session has a worktree', () => {
    // Promote first: a run config is read from a worktree, and there is not one yet.
    render(RunsPanel, { props: { session: session({ worktreePath: null, repos: [] }) } });
    expect(runMenu).not.toHaveBeenCalled();
  });

  it('offers to hand a FAILED run to the agent, and nothing else', async () => {
    /*
     * The one action a red row actually wants. On a green row it would be decoration, and
     * on a running one there is no verdict to explain yet — the server refuses that case
     * too, but a button you can press and that always fails is its own defect.
     */
    world.sessionHalf = {
      sessions: [], servers: {},
      runs: [
        { id: 'r-bad', name: 'Unit tests', repo: 'accept-blue', worktreePath: '/accept-blue/wt',
          cmd: 'npm test', status: 'failed', startedAt: 1, endedAt: 2, exitCode: 1, log: '/l' },
        { id: 'r-ok', name: 'Lint', repo: 'accept-blue', worktreePath: '/accept-blue/wt',
          cmd: 'npm run lint', status: 'passed', startedAt: 1, endedAt: 2, exitCode: 0, log: '/l' },
      ],
    } as never;

    render(RunsPanel, { props: { session: session() } });
    expect(screen.getByRole('button', { name: 'Send Unit tests to the agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send Lint to the agent' })).not.toBeInTheDocument();
  });

  it('asks the daemon to resolve the agent, rather than naming one itself', async () => {
    /*
     * A run belongs to a worktree and exactly one session owns a worktree, so the daemon
     * can resolve the target. Sending a session id from here would let a stale tab hand a
     * failure to whichever agent it last had selected.
     */
    world.sessionHalf = {
      sessions: [], servers: {},
      runs: [{ id: 'r-bad', name: 'Unit tests', repo: 'accept-blue', worktreePath: '/accept-blue/wt',
               cmd: 'npm test', status: 'failed', startedAt: 1, endedAt: 2, exitCode: 1, log: '/l' }],
    } as never;
    apiMock.mockResolvedValue({ ok: true });

    render(RunsPanel, { props: { session: session() } });
    screen.getByRole('button', { name: 'Send Unit tests to the agent' }).click();
    await tick();

    const call = apiMock.mock.calls.find((c) => String(c[1]).includes('/to-agent'));
    expect(call).toBeTruthy();
    expect(call?.[1]).toBe('/api/v1/runs/r-bad/to-agent');
    expect(call?.[2]).toEqual({});
  });
});
