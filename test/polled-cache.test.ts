/*
 * The one TTL cache the pulled feeds share (server/polled-cache.ts).
 *
 * Four modules had grown their own copy of these rules and they had already diverged: the
 * error TTL was in two of them and missing from the other two, so an outage was remembered
 * by half the daemon and re-attempted on every sweep by the other half. These tests are
 * about the rules themselves — each feed's own test file covers what its answers mean.
 *
 * Everything here runs on a fake clock, because the real TTLs are minutes and the bug the
 * error TTL prevents is only visible on the far side of one.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createPolledCache } from '../server/polled-cache.ts';

/** A cache over string keys whose loader counts its calls and can be made to fail. */
function counting(over: { ttlMs?: number; errorTtlMs?: number } = {}) {
  let clock = 1_000_000;
  let calls = 0;
  let fail: string | null = null;
  const cache = createPolledCache<string, string, string>({
    ttlMs: over.ttlMs ?? 60_000,
    errorTtlMs: over.errorTtlMs,
    now: () => clock,
    key: (k) => k,
    load: async (k) => {
      calls += 1;
      if (fail) throw new Error(fail);
      return `${k}:ok`;
    },
    onError: () => 'unknown',
    blank: {},
  });
  return {
    cache,
    calls: () => calls,
    advance: (ms: number) => {
      clock += ms;
    },
    breaks: (msg: string | null) => {
      fail = msg;
    },
  };
}

test('a fresh answer is not asked for again, and a stale one is asked for exactly once', async () => {
  // The whole point of the cache, and the property the feeds' TTLs were relying on while
  // nothing was actually ticking: time passing must be enough on its own.
  const c = counting({ ttlMs: 60_000 });
  await c.cache.refresh(['a']);
  await c.cache.refresh(['a']);
  assert.equal(c.calls(), 1, 'still fresh');

  c.advance(59_000);
  await c.cache.refresh(['a']);
  assert.equal(c.calls(), 1, 'one second short of the TTL is still fresh');

  c.advance(2_000);
  await c.cache.refresh(['a']);
  assert.equal(c.calls(), 2, 'past the TTL: asked');
  await c.cache.refresh(['a']);
  assert.equal(c.calls(), 2, 'and asked exactly once, not once per sweep');
});

test('a failure is remembered on its OWN ttl, so an outage is not hammered', async () => {
  /*
   * The rule that existed in two of the four copies. A tracker that is down or a token
   * that has expired must cost a handful of attempts an hour, not one per sweep for the
   * rest of the day — and the symptom of getting this wrong is only a warm laptop.
   */
  const c = counting({ ttlMs: 60_000, errorTtlMs: 300_000 });
  c.breaks('glab: 401');
  await c.cache.refresh(['a']);
  assert.equal(c.calls(), 1);
  assert.equal(c.cache.get('a')?.error, 'glab: 401', 'the reason is kept, not just the fact');
  assert.equal(c.cache.get('a')?.value, 'unknown', 'onError decides what a failure looks like');

  c.advance(120_000); // well past the success TTL, well inside the error one
  await c.cache.refresh(['a']);
  assert.equal(c.calls(), 1, 'a failure is trusted for longer than a success here');

  c.advance(200_000);
  c.breaks(null);
  await c.cache.refresh(['a']);
  assert.equal(c.calls(), 2, 'but outages end, so it does retry');
  assert.equal(c.cache.get('a')?.error, undefined, 'and the memory of the failure goes with it');
});

test('an error TTL SHORTER than the success TTL is equally honoured', async () => {
  // reviews.ts trusts a failure longer than a success (a subprocess per repo is dear);
  // task-status.ts trusts it for less (an outage ends and the answer is a round trip).
  // The cache must not have an opinion about which way round it is.
  const c = counting({ ttlMs: 600_000, errorTtlMs: 300_000 });
  c.breaks('Asana 503');
  await c.cache.refresh(['a']);
  c.advance(310_000);
  c.breaks(null);
  await c.cache.refresh(['a']);
  assert.equal(c.calls(), 2, 'past the error TTL but far inside the success one');
});

test('two overlapping sweeps become one in-flight sweep', async () => {
  /*
   * Two sweeps would double every subprocess for an answer neither produces sooner: the
   * second finds the first's entries still unwritten and asks about all of them again.
   * The loser reports ran:false rather than "nothing changed", because those are
   * different facts and a caller broadcasts on the second.
   */
  let inFlight = 0;
  let peak = 0;
  const cache = createPolledCache<string, string, string>({
    ttlMs: 60_000,
    key: (k) => k,
    load: async (k) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return k;
    },
    onError: () => '',
  });
  const [first, second] = await Promise.all([cache.refresh(['a', 'b']), cache.refresh(['c'])]);
  assert.equal(peak, 1, 'one loader at a time');
  assert.equal(first.ran, true);
  assert.equal(second.ran, false, 'the second call did nothing and must say so');
  assert.equal(cache.get('c'), undefined, 'the sweep that did not run asked about nothing');
});

test('forget() drops one key, and the next sweep re-asks for it', async () => {
  // The capability behind reviews.forget()/taskStatus.forget() — the contract that lets a
  // deleted feature leave the map instead of sitting in it for the life of the daemon.
  const c = counting();
  await c.cache.refresh(['a', 'b']);
  assert.equal(c.calls(), 2);
  assert.equal(c.cache.forget('a'), true);
  assert.equal(c.cache.forget('a'), false, 'forgetting what is not there is not a change');
  assert.deepEqual(
    c.cache.entries().map(([k]) => k),
    ['b'],
  );

  await c.cache.refresh(['a', 'b']);
  assert.equal(c.calls(), 3, 'a forgotten key is asked about again immediately, b is still fresh');
});

test('prune drops everything the sweep no longer mentions', async () => {
  // A repo that has left the scan, or a worktree that has been removed, must not leave
  // rows behind it — the snapshot has to track reality rather than history.
  const c = counting();
  await c.cache.refresh(['a', 'b'], { prune: true });
  await c.cache.refresh(['a'], { prune: true });
  assert.deepEqual(
    c.cache.entries().map(([k]) => k),
    ['a'],
  );
  assert.equal(c.calls(), 2, 'and pruning is not an excuse to re-ask about what is still fresh');
});

test('a loader that throws never rejects into the caller', async () => {
  /*
   * These are called from `void refresh()` sites, and crash.ts deliberately makes an
   * unhandled rejection FATAL — so a throw escaping here exits the daemon and takes every
   * PTY and the SSE fan-out with it, because a tracker was unreachable.
   */
  const cache = createPolledCache<string, string, string>({
    ttlMs: 0,
    key: (k) => k,
    load: async () => {
      throw new Error('boom');
    },
    onError: () => 'unknown',
  });
  const res = await cache.refresh(['a', 'b']);
  assert.deepEqual(res, { ran: true, loaded: 2, errors: 2 });
  assert.equal((await cache.fetch('a')).error, 'boom', 'fetch() is total too');
});

test('a loader that throws a non-Error is still recorded as a failure', async () => {
  // `throw 'nope'` out of a CLI wrapper must not become an unhandled anything.
  const cache = createPolledCache<string, string, string>({
    ttlMs: 60_000,
    key: (k) => k,
    load: async () => {
      throw 'nope';
    },
    onError: () => 'unknown',
  });
  await cache.refresh(['a']);
  assert.equal(cache.get('a')?.error, 'nope');
});

test('changed() is quiet about an empty cache and about a repeated answer', async () => {
  // A frame goes to every open client, so an unchanged snapshot is not news — and the
  // FIRST snapshot of a feed with nothing to report is not news either, which is what
  // `blank` is for.
  const c = counting();
  assert.equal(c.cache.changed({}), false, 'the empty snapshot matches the blank it was given');
  await c.cache.refresh(['a']);
  assert.equal(c.cache.changed({ a: 'a:ok' }), true);
  assert.equal(c.cache.changed({ a: 'a:ok' }), false, 'same answer, no frame');
});

test('load sees the previous entry, so a feed can answer without doing the work', async () => {
  // overlap.ts's whole economy: given its last answer it compares two shas and skips every
  // diff. Without the previous entry it would re-derive the same numbers on every sweep.
  const seen: Array<string | undefined> = [];
  const cache = createPolledCache<string, string, string>({
    ttlMs: 0, // always re-asked; the loader itself is what decides the work is unnecessary
    key: (k) => k,
    load: async (k, previous) => {
      seen.push(previous?.value);
      return previous?.value ?? `${k}:computed`;
    },
    onError: () => '',
  });
  await cache.refresh(['a']);
  await cache.refresh(['a']);
  assert.deepEqual(seen, [undefined, 'a:computed']);
});
