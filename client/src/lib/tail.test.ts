import { afterEach, describe, expect, it, vi } from 'vitest';
import { capLines, tailLog } from './tail.js';

/*
 * The byte-offset tail both log panels poll through.
 *
 * It was two copies before this, and every value they shared had drifted — the cap
 * existed in one of them, the near-bottom threshold was 60px in one and 40px in the
 * other. These pin the parts that are not visual: what offset the next request carries,
 * when the chain stops re-arming, and that a teardown really is the end of it.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('capLines', () => {
  it('keeps the LAST n lines, because a log is read from the end', () => {
    expect(capLines('a\nb\nc\nd', 2)).toBe('c\nd');
  });

  it('leaves a short buffer alone rather than trimming a line off it', () => {
    expect(capLines('a\nb', 5)).toBe('a\nb');
  });

  it('does not count the trailing newline as an empty last line', () => {
    // "a\nb\nc\n" is three lines, not four — capping at 2 must not answer "c\n" alone.
    expect(capLines('a\nb\nc\n', 2)).toBe('b\nc\n');
  });

  it('keeps a partial final line, which is what a byte tail always ends with', () => {
    expect(capLines('one\ntwo\nthr', 2)).toBe('two\nthr');
  });
});

describe('tailLog', () => {
  const scroller = () => null;

  it('carries the offset the server returned into the next request', async () => {
    vi.useFakeTimers();
    const seen: (number | undefined)[] = [];
    let n = 0;
    const stop = tailLog({
      fetch: async (offset) => {
        seen.push(offset);
        n += 1;
        return { text: `chunk ${n}\n`, offset: n * 10 };
      },
      onText: () => {},
      scroller,
      follow: () => false,
      interval: 100,
    });

    await vi.advanceTimersByTimeAsync(250);
    stop();

    // First call asks for everything; each later one resumes where the last ended.
    expect(seen.slice(0, 3)).toEqual([undefined, 10, 20]);
  });

  it('stops re-arming once `more` says the subject cannot change again', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => ({ text: 'x', offset: 1 }));
    let running = true;
    tailLog({ fetch, onText: () => {}, scroller, follow: () => false, interval: 100, more: () => running });

    await vi.advanceTimersByTimeAsync(150);
    const afterFirstPolls = fetch.mock.calls.length;
    expect(afterFirstPolls).toBeGreaterThan(1);

    running = false; // the run finished: its log is final
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(afterFirstPolls + 1);
  });

  it('a chunk that lands after teardown is dropped, not appended', async () => {
    vi.useFakeTimers();
    let release: (v: { text: string; offset: number }) => void = () => {};
    const appended: string[] = [];
    const stop = tailLog({
      fetch: () => new Promise((r) => (release = r)),
      onText: (c) => appended.push(c),
      scroller,
      follow: () => false,
      interval: 100,
    });

    // The panel is switched away from while the request is in flight — which is exactly
    // what a session change does, and the reply must not write into the next log.
    stop();
    release({ text: 'late bytes', offset: 5 });
    await vi.advanceTimersByTimeAsync(500);

    expect(appended).toEqual([]);
  });
});
