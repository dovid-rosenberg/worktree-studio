import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import SessionCard from './SessionCard.svelte';
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

  it('is one selectable control and carries no action buttons', () => {
    const { container } = render(SessionCard, { session: session() });
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('aria-label', 'Select session Find the session that made a…');
  });
});
