/**
 * A thrown value's message.
 *
 * `catch` binds `unknown`, and not everything thrown is an Error — a rejected fetch, a
 * string thrown by a library, a DOMException. This was written out at eighteen sites in
 * two forms, and one of them is a bug rather than a duplicate:
 *
 *   e instanceof Error ? e.message : String(e)   // correct, and the stated rule
 *   (e as Error).message                          // a CAST, not a check
 *
 * The cast form yields `undefined` for anything that is not an Error, so the toast reads
 * "undefined" and the actual failure is lost — which is worse than no message, because it
 * looks like the code handled it. The rule already existed in ops.svelte.ts; it was simply
 * not exported, so every component reinvented it or reached for the cast.
 *
 * Its own module, not api.ts: this is about the CATCH side, and importing an HTTP client
 * to format an error message is the kind of coupling that stops people importing at all.
 */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  // `String(undefined)` is the literal text "undefined", which is exactly the useless
  // output the cast form produced and the reason this module exists. A thrown null or
  // undefined carries no information, so say that rather than printing the word.
  if (e === null || e === undefined) return 'something failed, with no error given';
  if (typeof e === 'string') return e;
  // A rejected value with a message-ish shape (DOMException, some library errors).
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** True for the abort a cancelled in-flight request raises — not a failure worth showing. */
export function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}
