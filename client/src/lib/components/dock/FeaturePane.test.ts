import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import type { Feature } from '../../../../../server/types';

/*
 * What the dock shows for a feature with no agent.
 *
 * It used to open with a row of buttons duplicating the ActionBar's feature branch,
 * directly above the bar that already had them. Those are gone: the bottom bar acts,
 * this pane reads. So the tests are about what it TELLS you — branch, ports, merge
 * state, commits ahead of base, uncommitted files — and that it does not grow buttons
 * back.
 */
const api = vi.hoisted(() => vi.fn());
vi.mock('$lib/api.js', () => ({ api }));

const { default: FeaturePane } = await import('./FeaturePane.svelte');

const member = (repo: string, over: Record<string, unknown> = {}) => ({
  repo, wtname: 'token-race-fix', path: `/${repo}/wt`, branch: 'fix/token-create-race',
  running: false, canStart: true, ports: [], isMain: false, session: null, merged: false, ...over,
});

const feature = (over: Record<string, unknown> = {}): Feature => ({
  name: 'token-race-fix', auto: true, members: [member('accept-blue')], session: null, ...over,
} as unknown as Feature);

const roll = (repo: string, over: Record<string, unknown> = {}) => ({
  repo,
  branch: 'fix/token-create-race',
  base: 'develop',
  commits: [
    { sha: '6d9b13a8b0', subject: 'Match payment type in the duplicate-token check', author: 'd', when: 'today' },
    { sha: 'a21a3bf8d0', subject: 'Fix race in token creation', author: 'd', when: 'today' },
  ],
  uncommitted: { fileCount: 0, added: 0, deleted: 0 },
  ...over,
});

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue({ repos: [roll('accept-blue')] });
});

describe('FeaturePane', () => {
  it('names the feature and how it was grouped', async () => {
    render(FeaturePane, { feature: feature() });
    expect(screen.getByText('token-race-fix')).toBeInTheDocument();
    expect(screen.getByText(/grouped by shared worktree name/)).toBeInTheDocument();
  });

  it('says why a member cannot start rather than just "stopped"', () => {
    render(FeaturePane, { feature: feature({ members: [member('merchant-v3', { depsMissing: true })] }) });
    expect(screen.getByText('deps missing')).toBeInTheDocument();
  });

  it('labels ports with their repo, so several members are tellable apart', () => {
    render(FeaturePane, { feature: feature({ members: [member('accept-blue', { running: true, ports: [1233] })] }) });
    expect(screen.getByText('accept-blue:1233')).toBeInTheDocument();
  });

  it('answers "what is in here" — commits ahead of base, per repo', async () => {
    render(FeaturePane, { feature: feature() });
    await waitFor(() => expect(screen.getByText(/commits? ahead/)).toBeInTheDocument());
    expect(screen.getByText('vs develop')).toBeInTheDocument();
    expect(screen.getByText(/Match payment type/)).toBeInTheDocument();
    // Short sha, not the whole thing — the list is for recognising, not copying.
    expect(screen.getByText('6d9b13a8')).toBeInTheDocument();
  });

  it('says the working tree is clean rather than leaving it blank', async () => {
    render(FeaturePane, { feature: feature() });
    await waitFor(() => expect(screen.getByText(/working tree clean/)).toBeInTheDocument());
  });

  it('reports uncommitted work with its line counts', async () => {
    api.mockResolvedValue({ repos: [roll('accept-blue', { uncommitted: { fileCount: 3, added: 42, deleted: 7 } })] });
    render(FeaturePane, { feature: feature() });
    await waitFor(() => expect(screen.getByText(/uncommitted file/)).toBeInTheDocument());
    expect(screen.getByText('+42')).toBeInTheDocument();
    expect(screen.getByText('−7')).toBeInTheDocument();
  });

  it('says so when a branch has nothing on it yet', async () => {
    api.mockResolvedValue({ repos: [roll('accept-blue', { commits: [] })] });
    render(FeaturePane, { feature: feature() });
    await waitFor(() => expect(screen.getByText(/nothing committed on this branch yet/)).toBeInTheDocument());
  });

  it('surfaces a failed read instead of pretending the branch is empty', async () => {
    api.mockRejectedValue(new Error('git exploded'));
    render(FeaturePane, { feature: feature() });
    await waitFor(() => expect(screen.getByText('git exploded')).toBeInTheDocument());
  });

  it('fetches the rollup for the feature, by name', async () => {
    render(FeaturePane, { feature: feature() });
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(api).toHaveBeenCalledWith('GET', '/api/group/token-race-fix/commits');
  });

  it('grows no action buttons back — the ActionBar owns those', async () => {
    render(FeaturePane, { feature: feature() });
    await waitFor(() => expect(api).toHaveBeenCalled());
    for (const gone of ['Start session here', 'Run stack', 'Open in editor', 'Delete feature…']) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
  });
});
