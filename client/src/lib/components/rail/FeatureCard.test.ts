import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import FeatureCard from './FeatureCard.svelte';
import type { Feature } from '../../../../../server/types';

/*
 * The card is the densest thing on screen and it is what the user scans. It carried six
 * signals at once — a state dot, an agent pill with a SECOND dot for the same value, a
 * servers pill, a dot per member repo, a merged badge, a slot badge and a green edge —
 * so seven cards meant forty glyphs to find the one waiting agent.
 *
 * These pin the rule that replaced that: the dot is agent state, the green edge is
 * servers-up, and everything else appears ONLY when it is not the default. A pill
 * reappearing for `idle` is the regression to catch.
 */

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
  merged: false,
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

describe('FeatureCard', () => {
  it('names the feature and its member repos', () => {
    render(FeatureCard, { feature: feature({ members: [member('accept-blue'), member('merchant-v3')] }) });
    expect(screen.getByText('token-race-fix')).toBeInTheDocument();
    expect(screen.getByText('accept-blue')).toBeInTheDocument();
    expect(screen.getByText('merchant-v3')).toBeInTheDocument();
    expect(screen.getByText('2 repos')).toBeInTheDocument();
  });

  it('says nothing about an idle agent — absence is the signal', () => {
    const { container } = render(FeatureCard, {
      feature: feature({ session: { id: 's1', state: 'idle', activity: '', muxName: 'm' } }),
    });
    expect(screen.queryByText('idle')).not.toBeInTheDocument();
    // …but the dot still carries the state, which is the one place it lives.
    expect(container.querySelector('.dot.idle')).toBeTruthy();
  });

  it('labels an agent that is working or waiting, because those are worth finding', () => {
    render(FeatureCard, {
      feature: feature({ session: { id: 's1', state: 'waiting', activity: '', muxName: 'm' } }),
    });
    expect(screen.getByText('waiting')).toBeInTheDocument();
  });

  it('never renders a "servers stopped" label', () => {
    render(FeatureCard, { feature: feature() });
    expect(screen.queryByText(/servers/i)).not.toBeInTheDocument();
  });

  it('marks servers-up with the green edge rather than another pill', () => {
    const { container } = render(FeatureCard, {
      feature: feature({ members: [member('accept-blue', { running: true })] }),
    });
    expect(container.querySelector('.fcard.running')).toBeTruthy();
  });

  it('warns when a member cannot start for want of dependencies', () => {
    // `git worktree add` does not bring node_modules across, so the start command dies
    // on invocation. Saying it here is the difference between a half-failed stack and
    // a thing you can act on.
    render(FeatureCard, { feature: feature({ members: [member('merchant-v3', { depsMissing: true })] }) });
    expect(screen.getByText('deps missing')).toBeInTheDocument();
  });

  it('says "no session" for a feature nothing is driving', () => {
    render(FeatureCard, { feature: feature() });
    expect(screen.getByText('no session')).toBeInTheDocument();
  });

  it('shows the manual tag only for a config.groups feature', () => {
    render(FeatureCard, { feature: feature({ auto: false }) });
    expect(screen.getByText('manual')).toBeInTheDocument();
  });

  it('is one selectable control, and carries no action buttons', () => {
    // Actions moved to the ActionBar precisely so the card's height never changes:
    // hover-revealed buttons reflowed every row below and the list moved under the
    // pointer mid-aim.
    const { container } = render(FeatureCard, { feature: feature() });
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('aria-label', 'Select feature token-race-fix');
  });
});
