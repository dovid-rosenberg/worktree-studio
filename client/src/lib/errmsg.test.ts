import { describe, expect, it } from 'vitest';
import { errMessage, isAbort } from './errmsg.js';

/*
 * The cast form was a BUG, not a duplicate.
 *
 * Eighteen sites wrote this out, in two forms: the correct `e instanceof Error ? … : …`
 * and `(e as Error).message`, which is a cast rather than a check. The cast yields
 * `undefined` for anything that is not an Error — so the toast read "undefined" and the
 * real failure was lost, which is worse than no message because it looks handled.
 */
describe('errMessage', () => {
  it('reads an Error', () => {
    expect(errMessage(new Error('boom'))).toBe('boom');
  });

  it('survives a thrown STRING — where the cast produced "undefined"', () => {
    expect(errMessage('just a string')).toBe('just a string');
  });

  it('survives a message-shaped object that is not an Error', () => {
    // DOMException and several libraries throw these.
    expect(errMessage({ message: 'from a DOMException' })).toBe('from a DOMException');
  });

  it('never returns undefined, whatever it is handed', () => {
    for (const v of [null, undefined, 42, {}, []]) {
      const out = errMessage(v);
      expect(typeof out).toBe('string');
      expect(out).not.toBe('undefined');
    }
  });
});

describe('isAbort', () => {
  it('recognises the abort a cancelled request raises', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(isAbort(e)).toBe(true);
  });

  it('does not swallow a real failure', () => {
    expect(isAbort(new Error('network down'))).toBe(false);
    expect(isAbort('AbortError')).toBe(false);
  });
});
