import { describe, expect, it } from 'vitest';
import { hashForSelection, selectionFromHash } from './deeplink.js';
import { selectionKey } from './stores/ui.svelte.js';
import type { Selection } from './stores/ui.svelte.js';

/*
 * The URL fragment that lets something outside the app — Alfred, the menubar, a
 * bookmark — point at one session, feature or main-checkout server.
 *
 * It reuses the rail's own key scheme (`s:`/`f:`/`w:`) rather than inventing a
 * second vocabulary for the same three things. What these tests actually pin is
 * the encoding: feature names and absolute paths carry spaces, colons and other
 * characters that do not survive a naive split.
 */

const round = (s: Selection) => selectionFromHash(hashForSelection(s));

/*
 * ONE EXAMPLE PER SELECTION KIND, and the type is what enforces "per kind".
 *
 * `r:` reviews were encoded and never decoded: selecting a merge request wrote
 * `#r:accept-blue!4821` into the URL and opening that URL selected nothing. The decoder
 * simply had no branch for it, and nothing here noticed because the round-trip cases were
 * a hand-written list of three.
 *
 * A mapped type over `Selection['kind']` cannot be a hand-written list: add a kind to
 * Selection and this object stops compiling, so the build fails before the link does.
 */
type Kind = NonNullable<Selection>['kind'];
const EVERY_KIND: { [K in Kind]: Extract<NonNullable<Selection>, { kind: K }> } = {
  session: { kind: 'session', id: 's_abc' },
  // Each value carries a character that does not survive a naive split — a space, a
  // slash, a colon, a `#`, the `!` a review id is built from.
  feature: { kind: 'feature', name: 'fix/google pay' },
  mainserver: { kind: 'mainserver', path: '/Users/me/my code/a:b/#2 repo' },
  review: { kind: 'review', id: 'accept-blue!4821' },
};

describe('every Selection kind survives the round trip', () => {
  it.each(Object.entries(EVERY_KIND))('%s', (_kind, sel) => {
    const hash = hashForSelection(sel);
    // Not merely non-null: a decoder that returned the WRONG kind would pass that.
    expect(selectionFromHash(hash)).toEqual(sel);
    // …and the fragment is the rail key with the same prefix, escaped.
    expect(hash).toBe(`#${selectionKey(sel, encodeURIComponent)}`);
  });
});

describe('selectionFromHash', () => {
  it('reads every kind', () => {
    expect(selectionFromHash('#s:s_abc')).toEqual({ kind: 'session', id: 's_abc' });
    expect(selectionFromHash('#f:login-fix')).toEqual({ kind: 'feature', name: 'login-fix' });
    expect(selectionFromHash('#w:/code/api')).toEqual({ kind: 'mainserver', path: '/code/api' });
    expect(selectionFromHash('#r:accept-blue!4821')).toEqual({
      kind: 'review',
      id: 'accept-blue!4821',
    });
  });

  it('tolerates a missing leading #, because callers disagree about it', () => {
    expect(selectionFromHash('s:s_abc')).toEqual({ kind: 'session', id: 's_abc' });
  });

  it('is null for nothing, for junk, and for an unknown kind', () => {
    expect(selectionFromHash('')).toBeNull();
    expect(selectionFromHash('#')).toBeNull();
    expect(selectionFromHash('#nonsense')).toBeNull();
    expect(selectionFromHash('#x:whatever')).toBeNull();
    expect(selectionFromHash('#s:')).toBeNull();
  });

  it('keeps a value that itself contains a colon — a path is not a delimiter', () => {
    expect(selectionFromHash(hashForSelection({ kind: 'mainserver', path: '/code/a:b/api' }))).toEqual({
      kind: 'mainserver',
      path: '/code/a:b/api',
    });
  });

  it('survives a manual group name with a space in it', () => {
    expect(round({ kind: 'feature', name: 'MFA cleanup' })).toEqual({ kind: 'feature', name: 'MFA cleanup' });
  });

  it('survives a path with a space and a hash character', () => {
    const path = '/Users/me/Desktop/my code/#2 repo';
    expect(round({ kind: 'mainserver', path })).toEqual({ kind: 'mainserver', path });
  });
});

describe('hashForSelection', () => {
  it('is empty for nothing selected, so the URL carries no stale fragment', () => {
    expect(hashForSelection(null)).toBe('');
  });

  // Round-tripping every kind is asserted above, from a table the type system builds.
});

/*
 * The fragment scheme and the rail's row keys must stay the SAME scheme.
 *
 * `s:` / `f:` / `w:` was spelled out in four independent places — selectionKey, three
 * inline literals in railRows, and twice more here. This file's header already asserted
 * the coupling ("the fragment reuses the rail's own key scheme instead of inventing a
 * second vocabulary"), but the reuse was by convention, and convention does not fail a
 * build.
 *
 * The failure is silent: railDigits and goToNextWaiting both match a row's `key` against
 * selectionKey(selection). Change a prefix letter in one and the rail highlights nothing
 * while ⌥-digit picks the wrong row, with no compile error anywhere. So it is asserted.
 */
describe('the key scheme is shared, not merely similar', () => {
  const cases: Selection[] = [
    { kind: 'session', id: 's_abc' },
    { kind: 'feature', name: 'token-race-fix' },
    { kind: 'mainserver', path: '/code/accept-blue' },
  ];

  it('the URL fragment is the rail key, escaped — same prefix, same order', () => {
    for (const sel of cases) {
      expect(hashForSelection(sel)).toBe(`#${selectionKey(sel, encodeURIComponent)}`);
    }
  });

  it('a value needing escaping round-trips, and the rail key keeps it raw', () => {
    // A feature name with a space and a slash: the fragment must escape both, the row key
    // must not — they are the same structure with different escaping, which is exactly
    // why one encoder with an `enc` hook beats two spellings.
    const sel: Selection = { kind: 'feature', name: 'fix/google pay' };
    expect(selectionKey(sel)).toBe('f:fix/google pay');
    expect(hashForSelection(sel)).toBe('#f:fix%2Fgoogle%20pay');
    expect(selectionFromHash(hashForSelection(sel))).toEqual(sel);
  });

  it('nothing selected leaves no fragment behind', () => {
    expect(selectionKey(null)).toBe('');
    expect(hashForSelection(null)).toBe('');
  });
});
