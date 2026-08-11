import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';

/*
 * The Changes panel's session boundary.
 *
 * The bug this pins produced a 400 from the daemon and nothing else — the request that
 * went out named one session's id and a DIFFERENT session's repo:
 *
 *   GET /sessions/s_3b1e…/commit-detail?repo=ab-libraries&sha=544427a → 400
 *       {"error":"unknown repo or no worktree"}
 *
 * `loadCommits()` had no request stamp, only `select()` did. So switching sessions on
 * the rail while `/commits` was still out let the OLD answer land, write its repos into
 * `repos`, and pick a default selection from them — and `select()` reads the CURRENT
 * `sessionId`. Both halves were individually correct; crossing them was not.
 */

const api = vi.hoisted(() => ({
  fetchCommits: vi.fn(),
  fetchCommitDetail: vi.fn(),
  fetchHunks: vi.fn(),
  applyHunks: vi.fn(),
}));
vi.mock('./api.js', () => api);

import ReviewPanel from './ReviewPanel.svelte';

/** A `/commits` payload for one repo with one commit on it. */
function payload(repo: string, sha: string) {
  return {
    repos: [
      {
        repo,
        worktreePath: `/wt/${repo}`,
        branch: 'feat/x',
        base: 'abc',
        defaultBranch: 'main',
        commits: [{ sha, author: 'a', when: '', subject: 's', added: 1, deleted: 0, fileCount: 1 }],
        uncommitted: { fileCount: 0, added: 0, deleted: 0 },
      },
    ],
  };
}

/** A promise plus the handle to settle it, so a test can hold a request open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ReviewPanel session boundary', () => {
  it('drops a commit list that arrives after the session changed', async () => {
    const first = deferred<ReturnType<typeof payload>>();
    api.fetchCommits.mockReturnValueOnce(first.promise);
    api.fetchCommits.mockResolvedValueOnce(payload('web', 'bbbbbbb'));
    api.fetchCommitDetail.mockResolvedValue({ files: [] });

    const { rerender } = render(ReviewPanel, { props: { sessionId: 's_old' } });
    await tick();

    // The rail moves to another session while `/commits` for s_old is still in flight.
    await rerender({ sessionId: 's_new' });
    await tick();

    // ...and only now does the first request answer, with s_old's repos.
    first.resolve(payload('ab-libraries', '544427a'));
    await first.promise;
    await tick();
    await tick();

    // The exact crossed request the daemon rejected: the new session, the old repo.
    expect(api.fetchCommitDetail).not.toHaveBeenCalledWith('s_new', 'ab-libraries', expect.anything());
    // And nothing from the abandoned session is fetched under any id.
    for (const call of api.fetchCommitDetail.mock.calls) {
      expect(call[1]).not.toBe('ab-libraries');
    }
  });

  it('still loads the session it settled on', async () => {
    api.fetchCommits.mockResolvedValue(payload('web', 'bbbbbbb'));
    api.fetchCommitDetail.mockResolvedValue({ files: [] });

    render(ReviewPanel, { props: { sessionId: 's_new' } });
    await vi.waitFor(() => {
      expect(api.fetchCommitDetail).toHaveBeenCalledWith('s_new', 'web', 'bbbbbbb');
    });
  });
});
