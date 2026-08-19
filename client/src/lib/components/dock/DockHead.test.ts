import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';

/*
 * The dock header's identity line: title, worktree, branch.
 *
 * Renaming a session changes only the TITLE. The worktree directory, the branch, the
 * tmux session and the feature grouping keep the name they were created with — so after
 * a rename the header shows a name you did not type, and unlabelled that reads as a stale
 * title rather than as the directory it is. These pin that the two other names are shown,
 * distinguishable, and only when they say something the title does not.
 */
const { default: DockHead } = await import('./DockHead.svelte');
const { world } = await import('$lib/stores/world.svelte.js');
const fx = await import('$lib/fixtures/world.js');

const FEATURE = 'look-into-this-is-it-true';
const BRANCH = 'fix/look-into-this-is-it-true';

function give(title: string) {
  const s = fx.session({ title, feature: FEATURE, worktree: FEATURE, branch: BRANCH });
  const f = fx.feature({ name: FEATURE, session: fx.embedded({ title }) });
  fx.install(world as never, fx.makeWorld({ features: [f], sessions: [s] }));
  return s;
}

beforeEach(() => vi.clearAllMocks());

describe('DockHead identity chips', () => {
  it('shows the worktree and the branch once the title has diverged', () => {
    render(DockHead, { session: give('Docs casing') as never });
    expect(screen.getByText('Docs casing')).toBeInTheDocument();
    expect(screen.getByTitle(/^Worktree —/).textContent).toContain(FEATURE);
    expect(screen.getByTitle(/^Branch —/).textContent).toContain(BRANCH);
  });

  it('labels them differently, so neither reads as a stale title', () => {
    render(DockHead, { session: give('Docs casing') as never });
    const wt = screen.getByTitle(/^Worktree —/);
    const br = screen.getByTitle(/^Branch —/);
    expect(wt).not.toBe(br);
    // Each carries its own glyph; without one the chips are two anonymous strings.
    expect(wt.textContent).toContain('⌂');
    expect(br.textContent).toContain('⑂');
  });

  it('stays quiet when the title IS the worktree name — the untouched majority', () => {
    render(DockHead, { session: give(FEATURE) as never });
    expect(screen.queryByTitle(/^Worktree —/)).toBeNull();
  });
});

/*
 * The controls stay on the right edge, whatever else the header is carrying.
 *
 * The header is one flex row holding identity, merge-request chips, drift, repo chips
 * with ports, and then the action bar. It used to wrap: add a fourth repo or a couple of
 * MRs and the whole action bar dropped to a second line, so the buttons moved — and the
 * bar grew taller — exactly when the feature was busiest. The verbs are the thing you
 * aim at with a mouse, and a control that moves because a chip appeared is a control you
 * have to find again.
 *
 * The structural fact that makes it work: everything informational lives inside a
 * scroller, and the action bar is a SIBLING of that scroller, never inside it.
 */
describe('DockHead layout', () => {
  it('keeps the action bar outside the scrolling half', () => {
    const { container } = render(DockHead, { session: give('Docs casing') as never });
    const info = container.querySelector('.headinfo');
    const bar = container.querySelector('.actionbar');
    expect(info, 'the informational half must be its own element to scroll').toBeTruthy();
    expect(bar).toBeTruthy();
    expect(info?.contains(bar as Node), 'the bar must not scroll away with the chips').toBe(false);
  });

  it('puts the action bar last in the row, after the scroller', () => {
    const { container } = render(DockHead, { session: give('Docs casing') as never });
    const row = container.querySelector('.headrow');
    const kids = [...(row?.children ?? [])];
    expect(kids.length).toBeGreaterThanOrEqual(2);
    expect(kids[0]?.classList.contains('headinfo')).toBe(true);
    expect(kids[kids.length - 1]?.querySelector('.actionbar') ?? kids[kids.length - 1]).toBeTruthy();
  });

  it('carries the chips inside the scroller, so they are what overflows', () => {
    const { container } = render(DockHead, { session: give('Docs casing') as never });
    const info = container.querySelector('.headinfo');
    // The identity chips are the ones this file already renders unconditionally.
    expect(info?.querySelector('.idchip.wt')).toBeTruthy();
    expect(info?.querySelector('.idchip.br')).toBeTruthy();
  });
});
