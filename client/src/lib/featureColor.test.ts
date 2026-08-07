import { describe, expect, it } from 'vitest';
import { colorVars, isFeatureColor } from './featureColor.js';

/*
 * The contract every consumer leans on: an untagged (or unknown-tagged) feature yields
 * '', so `var(--fc, <default>)` falls through and the surface looks exactly as it did
 * before colours existed. That fallback IS the precedence rule in FeatureCard/DockHead —
 * if this returned a partial value for junk, an unrecognised id would paint half a card.
 */
describe('featureColor', () => {
  it('binds both variables for a known colour', () => {
    expect(colorVars('indigo')).toBe('--fc:var(--f-indigo);--fc-wash:var(--f-indigo-wash)');
  });

  it('yields nothing for absent, empty or unknown ids, so the fallback wins', () => {
    expect(colorVars(undefined)).toBe('');
    expect(colorVars('')).toBe('');
    expect(colorVars('chartreuse')).toBe('');
    // A colour removed from the palette in a later version must degrade, not half-paint.
    expect(colorVars('teal-2')).toBe('');
  });

  it('cannot be talked into injecting CSS', () => {
    expect(colorVars('red;background:url(x)')).toBe('');
    expect(isFeatureColor('teal')).toBe(true);
  });
});
