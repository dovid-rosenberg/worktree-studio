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
