// The CI push feed (server/ci.ts). What has to hold is not "a frame arrived" but
// the three properties the push model was worth having for:
//   * nothing spawns a forge CLI unless an SSE client is attached;
//   * a refresh happens on the events that plausibly change CI, and no more often
//     than the 20 s cache the old polling had already bounded it to;
//   * a slow or hung gh/glab is contained — it can never reject into the bus, and
//     it can never wedge the feed so no later refresh runs.
// The forge is injected, so no gh, no glab and no network are involved.
import { test } from 'node:test';
import assert from 'node:assert';
import { createCiFeed, DEFAULTS } from '../server/ci.ts';
import type { CiFeedDeps, CiSession } from '../server/ci.ts';
import type { CiEntry } from '../server/forge.ts';
import type { CiPayload, CiRepo } from '../server/types.ts';
import { present } from './helpers.ts';

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

async function waitFor(fn: () => unknown, { timeout = 2000, label = 'condition' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

// Intervals that put the feed on a millisecond timescale. The safety net is pushed
// out of the way by default so a test measures only the triggers it fired itself;
// the net has its own test that turns it back down.
const FAST = { debounceMs: 5, minSweepMs: 0, netMs: 3600000, tickMs: 10, sweepTimeoutMs: 3600000 };

// A stand-in forge: counts lookups (each stands for one spawned gh/glab), answers
// from a mutable table keyed by worktreePath, and records invalidate() calls.
// An answer is either the CiRepo body to hand back (the `repo` is stamped on from the
// entry) or a function computing one — a few tests need to see the entry they were asked
// about. Keyed by worktreePath, which is what the sweep looks a repo up by.
type CiAnswer = Omit<CiRepo, 'repo'> | ((entry: CiEntry) => CiRepo | Promise<CiRepo>);
function fakeForge(answers: Record<string, CiAnswer> = {}) {
  const f = {
    lookups: 0,
    invalidations: 0,
    answers,
    hang: false,
    async ciForRepo(entry: CiEntry): Promise<CiRepo> {
      f.lookups += 1;
      if (f.hang) return new Promise(() => {}); // a CLI that never comes back
      const a = entry.worktreePath ? f.answers[entry.worktreePath] : undefined;
      if (typeof a === 'function') return a(entry);
      return a ? { repo: entry.repo, ...a } : { repo: entry.repo, hasPR: false };
    },
    invalidate() {
      f.invalidations += 1;
    },
  };
  return f;
}

const SESSION = { id: 's_1', repos: [{ repo: 'api', worktreePath: '/w/a', branch: 'feature/a' }] };
const OPEN_PR = {
  hasPR: true,
  provider: 'github',
  number: 4,
  url: 'https://gh/4',
  state: 'OPEN',
  checks: { passed: 1, running: 0, failed: 0, total: 1 },
};

// A feed with one attached stream and one promoted session, unless overridden.
// `sessions`/`streams` take either a value or a thunk, so a test can change the
// answer mid-flight (a dashboard opening, a session going away).
// `sessions` and `streams` take a value OR a thunk: most tests want a constant, the
// ones about attention want to change it mid-flight.
interface FeedOpts {
  forge?: ReturnType<typeof fakeForge>;
  sessions?: CiSession[] | (() => CiSession[]);
  streams?: number | (() => number);
  intervals?: CiFeedDeps['intervals'];
}
function feed({ forge = fakeForge(), sessions = [SESSION], streams = 1, intervals = FAST }: FeedOpts = {}) {
  const frames: CiPayload[] = [];
  const f = createCiFeed({
    forge,
    sessions: () => (typeof sessions === 'function' ? sessions() : sessions),
    streams: () => (typeof streams === 'function' ? streams() : streams),
    onChange: () => frames.push(JSON.parse(JSON.stringify(f.snapshot()))),
    intervals,
  });
  return { feed: f, forge, frames };
}

// ---------------------------------------------------------------------------
// the gate: nobody watching → nothing spawns
// ---------------------------------------------------------------------------

test('with no SSE client attached, a poke spawns nothing at all', async () => {
  const { feed: f, forge, frames } = feed({ streams: 0, intervals: { ...FAST, netMs: 20 } });
  for (let i = 0; i < 20; i++) f.poke({ force: true });
  await sleep(120); // several heartbeats and several safety-net windows
  f.stop();
  assert.equal(forge.lookups, 0, 'a forge CLI must never be spawned for an audience of nobody');
  assert.equal(forge.invalidations, 0, 'and a dropped poke does not even touch the cache');
  assert.deepEqual(frames, []);
});

test('the safety net stays parked while nobody is watching and runs once someone is', async () => {
  let streams = 0;
  const { feed: f, forge } = feed({ streams: () => streams, intervals: { ...FAST, netMs: 20 } });
  await sleep(120);
  assert.equal(forge.lookups, 0, 'the heartbeat ticks but spawns nothing');
  streams = 1; // a dashboard opens
  await waitFor(() => forge.lookups > 0, { label: 'the net to fire once someone is looking' });
  f.stop();
});

test('a feed wired without a streams probe never sweeps — it fails closed', async () => {
  const forge = fakeForge();
  const f = createCiFeed({ forge, sessions: () => [SESSION], intervals: { ...FAST, netMs: 20 } });
  f.poke({ force: true });
  await sleep(100);
  f.stop();
  assert.equal(forge.lookups, 0);
});

// ---------------------------------------------------------------------------
// the snapshot and when it is emitted
// ---------------------------------------------------------------------------

test('a poke sweeps and pushes the snapshot keyed by session id', async () => {
  const { feed: f, frames } = feed({ forge: fakeForge({ '/w/a': OPEN_PR }) });
  f.poke();
  await waitFor(() => frames.length === 1, { label: 'the first ci frame' });
  f.stop();
  assert.deepEqual(frames[0], { ci: { s_1: [{ repo: 'api', ...OPEN_PR }] } });
});

test('the snapshot is re-emitted only when it actually differs', async () => {
  const forge = fakeForge({ '/w/a': OPEN_PR });
  const { feed: f, frames } = feed({ forge });
  f.poke();
  await waitFor(() => frames.length === 1, { label: 'frame 1' });
  f.poke();
  f.poke();
  f.poke();
  await sleep(60);
  assert.equal(frames.length, 1, 'an unchanged answer must not wake every subscriber');
  assert.ok(forge.lookups >= 2, 'it did look again — it just had nothing to say');

  forge.answers['/w/a'] = { ...OPEN_PR, checks: { passed: 0, running: 0, failed: 1, total: 1 } };
  f.poke();
  await waitFor(() => frames.length === 2, { label: 'the failed-checks frame' });
  f.stop();
  assert.equal(present(present(frames[1]).ci.s_1?.[0]?.checks, "s_1's checks").failed, 1);
});

test('a session with no worktree or no branch is absent from the snapshot and costs no lookup', async () => {
  const sessions = [
    { id: 's_new', repos: [{ repo: 'api', worktreePath: null, branch: null }] },
    { id: 's_1', repos: [{ repo: 'api', worktreePath: '/w/a', branch: 'feature/a' }] },
  ];
  const { feed: f, forge, frames } = feed({ forge: fakeForge({ '/w/a': OPEN_PR }), sessions });
  f.poke();
  await waitFor(() => frames.length === 1, { label: 'a frame' });
  f.stop();
  assert.deepEqual(Object.keys(frames[0].ci), ['s_1'], 'an unpromoted session has no CI half at all');
  assert.equal(forge.lookups, 1);
});

test('two sessions sharing a worktree+branch cost one lookup, and both get the answer', async () => {
  const sessions = [
    { id: 's_1', repos: [{ repo: 'api', worktreePath: '/w/a', branch: 'feature/a' }] },
    { id: 's_2', repos: [{ repo: 'api', worktreePath: '/w/a', branch: 'feature/a' }] },
  ];
  const { feed: f, forge, frames } = feed({ forge: fakeForge({ '/w/a': OPEN_PR }), sessions });
  f.poke();
  await waitFor(() => frames.length === 1, { label: 'a frame' });
  f.stop();
  assert.equal(forge.lookups, 1, 'one process per distinct worktree+branch, not per session');
  assert.deepEqual(frames[0].ci.s_1, frames[0].ci.s_2);
});

test('snapshot() is the `ci` half the bus writes, and it survives sessions going away', async () => {
  let sessions = [SESSION];
  const { feed: f, frames } = feed({ forge: fakeForge({ '/w/a': OPEN_PR }), sessions: () => sessions });
  assert.deepEqual(f.snapshot(), { ci: {} }, 'before the first sweep there is simply nothing to say');
  f.poke();
  await waitFor(() => frames.length === 1, { label: 'a frame' });
  sessions = [];
  f.poke();
  await waitFor(() => frames.length === 2, { label: 'the removal frame' });
  f.stop();
  assert.deepEqual(
    f.snapshot(),
    { ci: {} },
    'a closed session is simply absent — a replacement reports removals for free',
  );
});

// ---------------------------------------------------------------------------
// triggers: forced pokes invalidate, and the sweep rate stays floored
// ---------------------------------------------------------------------------

test('a forced poke drops the forge cache — the trigger knows the cached answer is wrong, not just old', async () => {
  const { feed: f, forge, frames } = feed({ forge: fakeForge({ '/w/a': OPEN_PR }) });
  f.poke({ force: true });
  await waitFor(() => frames.length === 1, { label: 'a frame' });
  f.stop();
  assert.equal(forge.invalidations, 1);
});

test('an unforced poke leaves the cache alone', async () => {
  const { feed: f, forge, frames } = feed({ forge: fakeForge({ '/w/a': OPEN_PR }) });
  f.poke();
  await waitFor(() => frames.length === 1, { label: 'a frame' });
  f.stop();
  assert.equal(forge.invalidations, 0, 'a subscriber arriving is not evidence that anything changed');
});

test('a storm of triggers is floored at minSweepMs — no more often than polling already cost', async () => {
  const forge = fakeForge({ '/w/a': OPEN_PR });
  const { feed: f } = feed({ forge, intervals: { ...FAST, minSweepMs: 300 } });
  const until = Date.now() + 400;
  while (Date.now() < until) {
    f.poke({ force: true });
    await sleep(2);
  } // ~200 triggers
  await sleep(50);
  f.stop();
  assert.ok(
    forge.lookups <= 3,
    `400 ms of continuous triggers must not become a spawn storm (was ${forge.lookups})`,
  );
  assert.ok(forge.lookups >= 1, 'but it does still refresh');
});

test("minSweepMs defaults to forge's CI_TTL, so the push model cannot shell out more often than the poll did", () => {
  assert.equal(DEFAULTS.minSweepMs, 20000);
});

// ---------------------------------------------------------------------------
// containment: a hung or exploding CLI
// ---------------------------------------------------------------------------

test('a hung forge lookup never rejects and never emits — and a later sweep still runs', async () => {
  const forge = fakeForge({ '/w/a': OPEN_PR });
  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => rejections.push(e);
  process.on('unhandledRejection', onRejection);
  const { feed: f, frames } = feed({ forge, intervals: { ...FAST, sweepTimeoutMs: 40 } });

  forge.hang = true;
  f.poke();
  await sleep(120); // the sweep is abandoned by its guard
  assert.deepEqual(frames, [], 'a wedged CLI says nothing rather than saying something wrong');

  forge.hang = false; // the CLI comes back
  f.poke();
  await waitFor(() => frames.length === 1, { label: 'the feed to recover' });
  f.stop();
  process.off('unhandledRejection', onRejection);
  assert.deepEqual(rejections, [], 'nothing may reject out of a sweep');
  assert.deepEqual(frames[0].ci.s_1[0], { repo: 'api', ...OPEN_PR });
});

test('a forge that throws is contained — the session comes back hasPR:false', async () => {
  const forge = fakeForge({
    '/w/a': () => {
      throw new Error('gh: exploded');
    },
  });
  const { feed: f, frames } = feed({ forge });
  f.poke();
  await waitFor(() => frames.length === 1, { label: 'a frame' });
  f.stop();
  assert.deepEqual(frames[0], { ci: { s_1: [{ repo: 'api', hasPR: false }] } });
});

test('a sessions() that throws cannot take the feed down', async () => {
  let broken = true;
  const forge = fakeForge({ '/w/a': OPEN_PR });
  const frames: CiPayload[] = [];
  const f = createCiFeed({
    forge,
    sessions: () => {
      if (broken) throw new Error('mid-restore');
      return [SESSION];
    },
    streams: () => 1,
    onChange: () => frames.push(f.snapshot()),
    intervals: FAST,
  });
  f.poke();
  await sleep(60);
  assert.deepEqual(frames, []);
  broken = false;
  f.poke();
  await waitFor(() => frames.length === 1, { label: 'the feed to recover' });
  f.stop();
});

test('an onChange listener that throws does not stop the next sweep', async () => {
  const forge = fakeForge({ '/w/a': OPEN_PR });
  let calls = 0;
  const f = createCiFeed({
    forge,
    sessions: () => [SESSION],
    streams: () => 1,
    onChange: () => {
      calls += 1;
      throw new Error('bus is on fire');
    },
    intervals: FAST,
  });
  f.poke();
  await waitFor(() => calls === 1, { label: 'the first (throwing) emit' });
  forge.answers['/w/a'] = { ...OPEN_PR, state: 'MERGED' };
  f.poke();
  await waitFor(() => calls === 2, { label: 'the second emit' });
  f.stop();
});

test('stop() parks the feed for good', async () => {
  const { feed: f, forge } = feed({
    forge: fakeForge({ '/w/a': OPEN_PR }),
    intervals: { ...FAST, netMs: 20 },
  });
  f.stop();
  f.poke({ force: true });
  await sleep(100);
  assert.equal(forge.lookups, 0);
});
