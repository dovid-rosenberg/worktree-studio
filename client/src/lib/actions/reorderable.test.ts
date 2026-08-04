import { describe, expect, it } from 'vitest';
import { moveItem } from './reorderable.js';

/*
 * The move itself, without a DOM.
 *
 * Order is not decoration here: `baseDirs` is scanned in order, and `start` / `editors`
 * serialize as objects whose key order IS their on-disk order. So an off-by-one in this
 * function reorders the user's config file, silently.
 *
 * It returns a new array rather than splicing in place because the caller holds it in
 * `$state` — a helper that mutated would change the data without redrawing the list.
 */
describe('moveItem', () => {
  it('moves an item down, shifting the ones it passes', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item up', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('returns a NEW array, so a $state assignment actually notifies', () => {
    const before = ['a', 'b'];
    const after = moveItem(before, 0, 1);
    expect(after).not.toBe(before);
    expect(before).toEqual(['a', 'b']);
  });

  it('is a no-op for a move onto itself', () => {
    const before = ['a', 'b', 'c'];
    expect(moveItem(before, 1, 1)).toBe(before);
  });

  it('refuses out-of-range indices rather than producing holes', () => {
    const before = ['a', 'b'];
    expect(moveItem(before, -1, 0)).toBe(before);
    expect(moveItem(before, 0, 5)).toBe(before);
    expect(moveItem(before, 5, 0)).toBe(before);
  });

  it('handles the ends, which is where an off-by-one would hide', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });
});
