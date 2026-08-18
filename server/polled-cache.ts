/*
 * ONE TTL CACHE, FOR EVERYTHING THAT IS PULLED RATHER THAN PUSHED.
 *
 * Four modules had grown their own copy of the same three ideas — reviews.ts (merge
 * requests), task-status.ts (tracker columns), overlap.ts (branch drift) and forge.ts's
 * CI lookups: an `at` timestamp checked against a TTL, a `running` flag so two sweeps
 * cannot overlap, and a JSON.stringify signature so an unchanged answer does not wake
 * every SSE client up.
 *
 * Four copies of a rule is four chances for one of them to be wrong, and one of them
 * already was — in the way this codebase keeps paying for. THE ERROR TTL existed in
 * reviews.ts and task-status.ts and in neither of the others: a forge that is down or a
 * token that has expired was remembered by two feeds and re-attempted on every single
 * sweep by the other two, so an outage turned into doomed subprocesses for the rest of
 * the day and the only symptom was a warm laptop. Written once, a failure is remembered
 * everywhere, and the interesting question ("how long is a failure worth trusting?")
 * becomes a number each feed chooses rather than a rule each feed remembers to write.
 *
 * What is deliberately NOT here: each feed keeps its own fetch function and its own
 * snapshot shape. This owns when to ask and what to do when asking fails, not what the
 * answer means.
 */

/** One key's cached answer, as the feeds read it. */
export interface PolledEntry<V> {
  /** when it was written, by the injected clock */
  at: number;
  value: V;
  /** the failure this entry remembers; absent on success. Its presence picks the TTL. */
  error?: string;
}

export interface PolledRefresh {
  /**
   * false when another sweep was already in flight and this call did nothing. Callers
   * broadcast on change, and "I could not look" is not "nothing changed" — reporting
   * them the same way would drop a frame the running sweep is about to justify.
   */
  ran: boolean;
  /** keys actually asked about (i.e. that were stale) */
  loaded: number;
  /** of those, the ones that failed and are now remembered as failures */
  errors: number;
}

export interface PolledCacheOptions<K, V, T> {
  /** how long a successful answer is trusted */
  ttlMs: number;
  /**
   * how long a FAILED answer is trusted. Defaults to ttlMs, but every caller should think
   * about it: longer than the success TTL says "an outage is expensive to re-probe"
   * (reviews: a subprocess per repo), shorter says "outages end and the answer is cheap".
   */
  errorTtlMs?: number;
  /** injectable so tests can drive a whole TTL cycle without waiting one out */
  now?: () => number;
  /** what identifies a target across sweeps — the cache key */
  key: (target: T) => K;
  /**
   * Ask the world. Gets the previous entry, because some feeds can answer far more
   * cheaply when they can see their last answer (overlap.ts compares two shas rather
   * than running any diff at all). Throwing here is the way to report a failure.
   */
  load: (target: T, previous: PolledEntry<V> | undefined) => Promise<V>;
  /**
   * What to store when `load` throws. Required, because the four feeds genuinely disagree
   * — an empty list, the previous answer, a `hasPR:false` row — and a default would be
   * one of them silently imposed on the rest.
   */
  onError: (target: T, error: Error, previous: PolledEntry<V> | undefined) => V;
  /**
   * The snapshot an EMPTY cache produces, for changed(). Without it the first sweep of a
   * feed with nothing to report would announce a change from "no signature" to "[]" and
   * push a frame saying nothing to every client.
   */
  blank?: unknown;
}

export interface PolledCache<K, V, T> {
  get(key: K): PolledEntry<V> | undefined;
  /** true while the key's answer is still within its TTL (success or error) */
  fresh(key: K): boolean;
  /** every held entry, in the order keys were first written */
  entries(): Array<[K, PolledEntry<V>]>;
  /**
   * Get one key, asking only if it is stale. For the lookup-shaped caller (forge.ts)
   * rather than the sweep-shaped ones. Never rejects.
   */
  fetch(target: T): Promise<PolledEntry<V>>;
  /**
   * Ask about everything stale in `targets`, one sweep at a time. NEVER REJECTS: these
   * are called from `void refresh()` sites under a crash.ts policy that makes an
   * unhandled rejection fatal, so a throw in here would take the daemon down — every PTY
   * and the SSE fan-out with it — over a tracker being unreachable.
   */
  refresh(targets: T[], opts?: { prune?: boolean }): Promise<PolledRefresh>;
  /** Has the derived snapshot moved since this was last asked? The change-detection half. */
  changed(snapshot: unknown): boolean;
  /** Drop one key. The capability behind each feed's forget(). */
  forget(key: K): boolean;
  /** Drop every key not in `live`, so a cache tracks reality rather than history. */
  prune(live: Iterable<K>): number;
  clear(): void;
}

export function createPolledCache<K, V, T = K>(opts: PolledCacheOptions<K, V, T>): PolledCache<K, V, T> {
  const { ttlMs, errorTtlMs = ttlMs, now = () => Date.now(), key, load, onError, blank } = opts;
  const cache = new Map<K, PolledEntry<V>>();
  let sig = JSON.stringify(blank);
  let running = false;

  function fresh(k: K): boolean {
    const e = cache.get(k);
    if (!e) return false;
    return now() - e.at < (e.error ? errorTtlMs : ttlMs);
  }

  // One key, asked and stored. The catch is what makes every caller total: a failure is
  // recorded WITH A TIMESTAMP, which is the part that stops the next sweep asking again.
  async function ask(target: T): Promise<{ entry: PolledEntry<V>; failed: boolean }> {
    const k = key(target);
    const previous = cache.get(k);
    let entry: PolledEntry<V>;
    let failed = false;
    try {
      entry = { at: now(), value: await load(target, previous) };
    } catch (e) {
      failed = true;
      const err = e instanceof Error ? e : new Error(String(e));
      entry = { at: now(), value: onError(target, err, previous), error: err.message || String(err) };
    }
    cache.set(k, entry);
    return { entry, failed };
  }

  function prune(live: Iterable<K>): number {
    const keep = new Set(live);
    let dropped = 0;
    for (const k of [...cache.keys()]) if (!keep.has(k) && cache.delete(k)) dropped += 1;
    return dropped;
  }

  async function refresh(targets: T[], { prune: dropStale = false } = {}): Promise<PolledRefresh> {
    // One sweep at a time. Two overlapping sweeps double every request for an answer
    // neither produces sooner, because the second finds the first's entries unwritten.
    if (running) return { ran: false, loaded: 0, errors: 0 };
    running = true;
    let loaded = 0;
    let errors = 0;
    try {
      if (dropStale) prune(targets.map(key));
      // Serial on purpose: each of these is a subprocess or an HTTP round trip, and the
      // whole point of the module is to be quiet in the background.
      for (const t of targets) {
        if (fresh(key(t))) continue;
        loaded += 1;
        if ((await ask(t)).failed) errors += 1;
      }
    } finally {
      running = false;
    }
    return { ran: true, loaded, errors };
  }

  return {
    get: (k) => cache.get(k),
    fresh,
    entries: () => [...cache],
    refresh,
    prune,

    async fetch(target: T): Promise<PolledEntry<V>> {
      const k = key(target);
      const hit = cache.get(k);
      if (hit && fresh(k)) return hit;
      return (await ask(target)).entry;
    },

    changed(snapshot: unknown): boolean {
      const next = JSON.stringify(snapshot);
      if (next === sig) return false;
      sig = next;
      return true;
    },

    forget: (k) => cache.delete(k),
    clear: () => cache.clear(),
  };
}
