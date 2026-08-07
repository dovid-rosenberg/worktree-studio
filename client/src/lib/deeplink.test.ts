import { describe, expect, it } from 'vitest';
import { hashForSelection, selectionFromHash } from './deeplink.js';
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

describe('selectionFromHash', () => {
  it('reads the three kinds', () => {
    expect(selectionFromHash('#s:s_abc')).toEqual({ kind: 'session', id: 's_abc' });
    expect(selectionFromHash('#f:login-fix')).toEqual({ kind: 'feature', name: 'login-fix' });
    expect(selectionFromHash('#w:/code/api')).toEqual({ kind: 'mainserver', path: '/code/api' });
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

  it('round-trips every kind', () => {
    const cases: Selection[] = [
      { kind: 'session', id: 's_1' },
      { kind: 'feature', name: 'login-fix' },
      { kind: 'mainserver', path: '/code/api' },
    ];
    for (const c of cases) expect(round(c)).toEqual(c);
  });
});
