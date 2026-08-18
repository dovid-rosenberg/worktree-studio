/**
 * One localStorage-backed preference: how it is read, how it is written, and the one
 * try/catch both of those need.
 *
 * There were five of these pairs in ui.svelte.ts and a sixth in theme.svelte.ts, each
 * spelling out the same three lines. The try/catch is not decoration: in private
 * browsing `localStorage.setItem` THROWS (Safari) and in the `logic` test project — node,
 * no DOM — the identifier does not exist at all, so an unguarded read is a ReferenceError
 * during class-field initialisation, i.e. before the app has a chance to render anything.
 * Six copies of a guard is six chances to write the seventh without one.
 *
 * `parse` and `serialize` are the pair, so a value only has to describe its own shape
 * once. `parse(null)` is the default and must be total — it is what a missing key, a
 * malformed value and a storage-less environment all fall back to.
 */
export interface Persisted<T> {
  /** The stored value, or `parse(null)` when there is nothing readable. */
  load(): T;
  /** Store it, or do nothing at all — a preference that cannot persist is not an error. */
  save(value: T): void;
}

export function persisted<T>(
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string = String,
): Persisted<T> {
  return {
    load(): T {
      try {
        return parse(localStorage.getItem(key));
      } catch {
        // Storage unavailable, or a stored value `parse` could not make sense of. Both
        // mean the same thing to the caller: use the default.
        return parse(null);
      }
    },
    save(value: T): void {
      try {
        localStorage.setItem(key, serialize(value));
      } catch {
        /* private browsing: the choice simply does not persist */
      }
    },
  };
}
