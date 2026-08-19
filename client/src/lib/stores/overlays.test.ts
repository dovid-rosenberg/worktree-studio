import { beforeEach, describe, expect, it } from 'vitest';
import { overlays } from './overlays.svelte.js';

/*
 * Escape closes what is actually on top.
 *
 * The dismissal order used to be a hardcoded if-chain — palette, then search, then
 * settings, then intake — written as a comment at the top of the file. That is right for
 * the order those surfaces are usually opened in and wrong for any other: open the
 * palette, run "Settings" from it, press Escape, and the palette closed while Settings —
 * the thing you were looking at — stayed up.
 *
 * A stack has no order to state, so a fifth surface cannot get it wrong.
 */
beforeEach(() => {
  while (overlays.escape()) {
    /* drain */
  }
});

describe('overlays', () => {
  it('closes nothing when nothing is open', () => {
    expect(overlays.escape()).toBe(false);
    expect(overlays.any).toBe(false);
  });

  it('closes the most recently opened surface, not a hardcoded favourite', () => {
    overlays.togglePalette();
    overlays.openSettings();
    expect(overlays.palette).toBe(true);
    expect(overlays.settings).toBe(true);

    expect(overlays.escape()).toBe(true);
    expect(overlays.settings, 'settings was on top, so settings closes').toBe(false);
    expect(overlays.palette, 'the palette underneath survives').toBe(true);
  });

  it('still closes the palette first when the palette was opened last', () => {
    overlays.openSettings();
    overlays.togglePalette();
    overlays.escape();
    expect(overlays.palette).toBe(false);
    expect(overlays.settings).toBe(true);
  });

  it('re-opening an already-open surface moves it to the top rather than duplicating', () => {
    overlays.openSettings();
    overlays.openIntake();
    overlays.openSettings();
    overlays.escape();
    expect(overlays.settings).toBe(false);
    expect(overlays.intake).toBe(true);
    // One escape per surface — a duplicate entry would need two.
    overlays.escape();
    expect(overlays.any).toBe(false);
  });

  it('openSearch still closes the palette it was launched from', () => {
    overlays.togglePalette();
    overlays.openSearch();
    expect(overlays.palette).toBe(false);
    expect(overlays.search).toBe(true);
  });

  it('closing a buried surface directly leaves the rest of the stack intact', () => {
    overlays.openSettings();
    overlays.togglePalette();
    overlays.closeSettings();
    expect(overlays.settings).toBe(false);
    expect(overlays.palette).toBe(true);
    expect(overlays.escape()).toBe(true);
    expect(overlays.any).toBe(false);
  });

  it('clears settingsSection when settings closes, however it closes', () => {
    overlays.openSettings('servers');
    expect(overlays.settingsSection).toBe('servers');
    overlays.escape();
    expect(overlays.settingsSection).toBe(null);
  });
});
