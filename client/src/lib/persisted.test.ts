import { afterEach, describe, expect, it, vi } from 'vitest';
import { persisted } from './persisted.js';

/*
 * The reader/writer pair behind every remembered preference — the dock view, the rail
 * width and sort, the chosen root, the dismissed split findings, the theme.
 *
 * Six copies of these three lines existed before this, which is six chances to write the
 * seventh without the try/catch. What the guard is actually for is not hypothetical:
 * Safari's private mode throws on setItem, and the `logic` test project runs in node
 * where the identifier does not exist at all — an unguarded read there throws during
 * class-field initialisation, i.e. before anything renders.
 */

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('persisted', () => {
  it('round-trips through the key it was given', () => {
    const p = persisted<string>('wts-test-a', (raw) => raw || 'fallback');
    p.save('chosen');
    expect(localStorage.getItem('wts-test-a')).toBe('chosen');
    expect(p.load()).toBe('chosen');
  });

  it('parses on the way in and serialises on the way out — one shape, described once', () => {
    const p = persisted<Set<string>>(
      'wts-test-set',
      (raw) => new Set<string>(JSON.parse(raw || '[]')),
      (v) => JSON.stringify([...v]),
    );
    p.save(new Set(['a', 'b']));
    expect(localStorage.getItem('wts-test-set')).toBe('["a","b"]');
    expect(p.load()).toEqual(new Set(['a', 'b']));
  });

  it('falls back for a missing key rather than handing back null', () => {
    const p = persisted<number>('wts-test-missing', (raw) => (raw === null ? 42 : Number(raw)));
    expect(p.load()).toBe(42);
  });

  it('falls back when the STORED value is junk — parse throwing is not a crash', () => {
    localStorage.setItem('wts-test-junk', 'not json');
    const p = persisted<string[]>('wts-test-junk', (raw) => JSON.parse(raw || '[]'));
    expect(p.load()).toEqual([]);
  });

  it('survives a getItem that throws, which is private mode', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const p = persisted<string>('wts-test-b', (raw) => raw || 'fallback');
    expect(p.load()).toBe('fallback');
  });

  it('swallows a setItem that throws — a preference that cannot persist is not an error', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const p = persisted<string>('wts-test-c', (raw) => raw || 'fallback');
    expect(() => p.save('chosen')).not.toThrow();
    expect(setItem).toHaveBeenCalledOnce();
  });

  it('survives storage not existing at all — the node test project has no localStorage', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    // Deleting rather than stubbing: a ReferenceError and a throwing getter are different
    // failures, and the store hits the first one in the `logic` project.
    // biome-ignore lint/performance/noDelete: restoring the descriptor afterwards is the point
    delete (globalThis as { localStorage?: unknown }).localStorage;
    try {
      const p = persisted<string>('wts-test-d', (raw) => raw || 'fallback');
      expect(p.load()).toBe('fallback');
      expect(() => p.save('chosen')).not.toThrow();
    } finally {
      if (real) Object.defineProperty(globalThis, 'localStorage', real);
    }
  });
});
