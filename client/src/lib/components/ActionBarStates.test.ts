import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';

/*
 * Every gallery state renders, and renders something.
 *
 * The action bar is 27 controls behind six derived flags across four selection kinds,
 * and until now each test picked one combination by hand — so a state nobody had thought
 * to write a test for could break and stay broken until somebody happened to select the
 * right thing in the browser.
 *
 * This asserts the weaker but broader property: for each named state in GALLERY_STATES,
 * the bar mounts without throwing and puts controls on screen. It shares its list with
 * /gallery, so adding a cell there adds a case here — which is what stops the two from
 * describing different apps.
 */
vi.mock('$lib/components/RunConfigMenu.svelte', () => ({ default: vi.fn() as never }));
vi.mock('$lib/components/SlotMenu.svelte', () => ({ default: vi.fn() as never }));

const { default: ActionBar } = await import('./ActionBar.svelte');
const { ui } = await import('$lib/stores/ui.svelte.js');
const { world } = await import('$lib/stores/world.svelte.js');
const fx = await import('$lib/fixtures/world.js');
const { GALLERY_STATES } = await import('$lib/fixtures/states.js');

beforeEach(() => {
  ui.clearSelection();
  fx.install(world as never, fx.makeWorld());
});

describe('ActionBar across every gallery state', () => {
  it('enumerates a state list worth calling a matrix', () => {
    expect(GALLERY_STATES.length).toBeGreaterThanOrEqual(10);
    const names = GALLERY_STATES.map((s) => s.name);
    expect(new Set(names).size, 'state names must be unique — they key the gallery cells').toBe(names.length);
  });

  for (const state of GALLERY_STATES) {
    it(`renders: ${state.name}`, () => {
      state.apply(fx, world as never, ui as never);
      expect(() => render(ActionBar)).not.toThrow();

      if (state.name === 'nothing selected') {
        // The one state whose whole job is to say something rather than offer something.
        expect(screen.getByText(/Select a feature, session or server/)).toBeInTheDocument();
      } else {
        expect(
          screen.getAllByRole('button').length,
          'a selected thing must offer at least one verb',
        ).toBeGreaterThan(0);
      }
    });
  }
});
