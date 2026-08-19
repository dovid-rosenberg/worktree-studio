import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import SessionCard from './SessionCard.svelte';
import { STALE_AFTER_MS, world } from '$lib/stores/world.svelte.js';
import type { Session } from '../../../../../server/types';

/*
 * The card for an UNPROMOTED agent — one with no worktree, and therefore no feature to
 * sit under. Promoted sessions are drawn by FeatureCard.
 *
 * Same rule as that card, pinned here too: fixed height, no buttons. Actions moved to
 * the ActionBar because hover-revealed ones grew the card and reflowed every row
 * beneath it, so the list moved under the pointer mid-aim.
 */
vi.mock('$lib/ops.svelte.js', () => ({
  promote: vi.fn(),
  activateSession: vi.fn(),
  closeSession: vi.fn(),
  pending: new Set(),
}));

const session = (over: Record<string, unknown> = {}): Session =>
  ({
    id: 's1',
    title: 'Find the session that made a…',
    state: 'waiting',
    activity: 'Waiting for your input',
    source: 'freetext',
    sourceUrl: null,
    repoName: 'accept-blue',
    worktreePath: null,
    repos: [],
    ...over,
  }) as unknown as Session;

describe('SessionCard', () => {
  it('shows the title, source and activity', () => {
    render(SessionCard, { session: session() });
    expect(screen.getByText('Find the session that made a…')).toBeInTheDocument();
    expect(screen.getByText('freetext')).toBeInTheDocument();
    expect(screen.getByText('Waiting for your input')).toBeInTheDocument();
  });

  it('falls back to the primary repo when the session owns no repo list', () => {
    render(SessionCard, { session: session() });
    expect(screen.getByText('accept-blue')).toBeInTheDocument();
  });

  it('links an issue-backed session to its source, opening away from the app', () => {
    render(SessionCard, {
      session: session({ source: 'github', sourceId: 412, sourceUrl: 'https://example.test/i/412' }),
    });
    const link = screen.getByRole('link', { name: 'GH#412' });
    expect(link).toHaveAttribute('href', 'https://example.test/i/412');
    expect(link).toHaveAttribute('target', '_blank');
    // Without rel=noreferrer the opened tab can reach back through window.opener.
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('dims a stopped agent without hiding it — it is still resumable', () => {
    const { container } = render(SessionCard, { session: session({ state: 'stopped' }) });
    expect(container.querySelector('.scard.stoppedrow')).toBeTruthy();
    expect(screen.getByText('stopped')).toBeInTheDocument();
  });

  /*
   * A session whose hooks have stopped firing must not keep claiming to work.
   *
   * Everything on this card is the LAST thing the agent reported, and nothing said how old
   * that was — so a wedged agent, a deleted settings file or a failing report.sh left
   * `working · running Bash` on screen indefinitely, indistinguishable from real work.
   */
  it('marks a busy session whose hooks have gone quiet, and says for how long', () => {
    const t = 1_700_000_000_000;
    world.now = t + STALE_AFTER_MS + 2 * 60_000;
    render(SessionCard, {
      session: session({ state: 'working', activity: 'running Bash', lastEventAt: t }),
    });
    expect(screen.getByText('no signal 14m')).toBeInTheDocument();
    // Beside the state, not instead of it: the last report is still the best guess at what
    // it was doing, and both halves are needed to know what to go and look at.
    expect(screen.getByText('working')).toBeInTheDocument();
    expect(screen.getByText('running Bash')).toBeInTheDocument();
  });

  it('leaves a busy session that reported recently alone', () => {
    const t = 1_700_000_000_000;
    world.now = t + 9 * 60_000; // a long Bash call is legitimately this quiet
    const { container } = render(SessionCard, {
      session: session({ state: 'working', activity: 'running Bash', lastEventAt: t }),
    });
    expect(container.querySelector('.pill.stale')).toBeNull();
  });

  it('never nags an idle session — waiting on a human is not a fault', () => {
    const t = 1_700_000_000_000;
    world.now = t + 5 * 60 * 60_000;
    const { container } = render(SessionCard, { session: session({ state: 'idle', lastEventAt: t }) });
    expect(container.querySelector('.pill.stale')).toBeNull();
  });

  it('is one selectable control and carries no action buttons', () => {
    const { container } = render(SessionCard, { session: session() });
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('aria-label', 'Select session Find the session that made a…');
  });
});
