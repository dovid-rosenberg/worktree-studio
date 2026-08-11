/*
 * ONE byte-offset log tail, for the two panels that poll one.
 *
 * `GET …?offset=<n>` returns the bytes after `offset` plus the new offset, so both
 * panels are a poll rather than a stream: streaming a test suite's stdout over the SSE
 * fan-out would put it on the same channel as agent state.
 *
 * It was implemented twice — LogsPanel and RunsPanel — and the two copies had already
 * drifted apart on every value they share. What follows is the decision on each, because
 * "whichever was written second" is not a reason:
 *
 *   NEAR-BOTTOM THRESHOLD: 60px, LogsPanel's, not RunsPanel's 40px. It is the tolerance
 *   for "the user is still reading the end", and the unit that matters is a line: at
 *   these panels' line heights (~19px and ~20px) 60px is three lines and 40px is two.
 *   Three is the safer of the two — the cost of being wrong is a jump away from what
 *   somebody is reading, against a scroll they can undo with one flick.
 *
 *   MEASURED BEFORE THE APPEND, AFTER THE FETCH. LogsPanel measured before awaiting,
 *   which answers the question about a state up to a second old. Appending first would be
 *   worse still: the scroller has already grown, so "am I at the bottom" is answered about
 *   the new content rather than the old.
 *
 *   SELF-SCHEDULING setTimeout, NEVER setInterval — both copies had this and it is the
 *   one thing neither could afford to lose: a response slower than the interval would
 *   otherwise stack requests behind it and double-append.
 *
 *   INTERVAL stays per-caller. It is the only difference that is about the SUBJECT rather
 *   than about tailing: a run is a thing you are watching finish (900ms), a dev server log
 *   is ambient (1500ms).
 *
 * What stays with the callers is what they do with the bytes: RunsPanel keeps one string,
 * LogsPanel splits into classified line objects and must therefore buffer the trailing
 * partial line itself. Both cap — see capLines.
 */

/**
 * How much scrollback either panel keeps.
 *
 * LogsPanel capped and RunsPanel did not, which is not a difference between them: a
 * failing test suite prints as much as a dev server does, and the uncapped side grows a
 * DOM node (or a string) per line for as long as the panel is open.
 */
export const MAX_LOG_LINES = 2000;

/** Drop everything but the last `max` lines. Cheap enough to run per chunk. */
export function capLines(text: string, max: number = MAX_LOG_LINES): string {
  let cut = -1;
  let seen = 0;
  // Walk back from the end rather than split(): a 2000-line cap on a 50k-line buffer
  // otherwise allocates the 50k-element array to throw 48k of it away.
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== '\n') continue;
    // The final newline terminates the last line rather than starting a new one.
    if (i === text.length - 1) continue;
    if (++seen === max) {
      cut = i + 1;
      break;
    }
  }
  return cut <= 0 ? text : text.slice(cut);
}

export interface Chunk {
  text?: string;
  offset?: number;
}

export interface TailOptions {
  /** Fetch the bytes after `offset`; `undefined` on the first call means "from the start". */
  fetch: (offset: number | undefined) => Promise<Chunk>;
  /** Hand the caller each non-empty chunk. Whatever it does with it is the caller's shape. */
  onText: (chunk: string) => void;
  /** The scrolling element, read at tick time — it is bound after this starts. */
  scroller: () => HTMLElement | null;
  /** Whether the user still wants to be pinned to the bottom. */
  follow: () => boolean;
  /** Milliseconds between polls — see the note above on why this is not fixed. */
  interval: number;
  /**
   * Re-arm? Default is "always". RunsPanel says no once its run has finished: a finished
   * run's log is final, so polling it forever is a request a second for a file that
   * cannot change.
   */
  more?: () => boolean;
}

/** How close to the bottom still counts as "reading the end" — three lines. See above. */
const NEAR_PX = 60;

/**
 * Start tailing. Returns the teardown, so the whole thing is one line inside an $effect:
 *
 *     $effect(() => tailLog({ ... }));
 */
export function tailLog(o: TailOptions): () => void {
  let alive = true;
  let offset: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    if (!alive) return;
    try {
      const res = await o.fetch(offset);
      if (!alive) return;
      if (res.text) {
        const el = o.scroller();
        const near = !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_PX;
        o.onText(res.text);
        offset = res.offset;
        if (o.follow() && near)
          // After the render, not before it: scrollHeight has to include the new lines.
          queueMicrotask(() => {
            const now = o.scroller();
            if (now) now.scrollTop = now.scrollHeight;
          });
      } else if (res.offset !== undefined) {
        offset = res.offset;
      }
    } catch {
      /* a log read must not take the panel with it — the next tick tries again */
    }
    if (alive && (o.more?.() ?? true)) timer = setTimeout(tick, o.interval);
  };
  void tick();

  return () => {
    alive = false;
    if (timer) clearTimeout(timer);
  };
}
