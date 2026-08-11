/*
 * The review queue feed (server/reviews.ts).
 *
 * A merge request waiting on you is external state on somebody else's server, reached by
 * a subprocess per repo. So the contract worth pinning is not "does it list things" — it
 * is everything around that: what gets cached, what a failure costs, and what happens to
 * a repo that goes away.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createReviewFeed } from '../server/reviews.ts';
import type { ReviewItem } from '../server/types.ts';

const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
  provider: 'gitlab',
  repo: '',
  number: 1906,
  title: 'Create Mobile App site',
  url: 'https://git/mr/1906',
  author: 'yocheved',
  draft: false,
  branch: 'add/mobile-app-site',
  target: 'develop',
  updatedAt: '2026-08-10T18:56:53.487Z',
  ...over,
});

const repo = (name: string) => ({ name, path: `/code/${name}` });

test('stamps each item with the repo it was found in', async () => {
  // The CLI answers per checkout and cannot know what Studio calls the repo, so the sweep
  // is the only thing that can fill this in — and the rail groups on it.
  const feed = createReviewFeed({ list: async () => [item()] });
  await feed.refresh([repo('accept-blue')]);
  assert.equal(feed.snapshot()[0].repo, 'accept-blue');
});

test('puts drafts last and the freshest first', async () => {
  /*
   * A draft is somebody thinking out loud — in the queue because they asked, but rarely
   * the next thing to do. Sorted rather than hidden: a draft sitting for a week is still
   * worth seeing.
   */
  const feed = createReviewFeed({
    list: async () => [
      item({ number: 1, draft: true, updatedAt: '2026-08-10T12:00:00Z' }),
      item({ number: 2, updatedAt: '2026-08-01T12:00:00Z' }),
      item({ number: 3, updatedAt: '2026-08-09T12:00:00Z' }),
    ],
  });
  await feed.refresh([repo('r')]);
  assert.deepEqual(
    feed.snapshot().map((i) => i.number),
    [3, 2, 1],
  );
});

test('does not ask again while the answer is fresh', async () => {
  let calls = 0;
  const feed = createReviewFeed({
    list: async () => {
      calls += 1;
      return [item()];
    },
  });
  await feed.refresh([repo('r')]);
  await feed.refresh([repo('r')]);
  assert.equal(calls, 1, 'a subprocess per repo is not free');
});

test('remembers a failure, so an outage is not hammered', async () => {
  /*
   * The thing that is easy to leave out. Without this, a forge that is down or a token
   * that has expired means a dozen doomed subprocesses every sweep for the rest of the
   * day, and the only symptom is a warm laptop.
   */
  let calls = 0;
  let now = 1_000_000;
  const feed = createReviewFeed({
    list: async () => {
      calls += 1;
      throw new Error('glab: 401');
    },
    now: () => now,
  });
  await feed.refresh([repo('r')]);
  assert.equal(calls, 1);
  assert.deepEqual(feed.snapshot(), []);

  now += 6 * 60 * 1000; // past the success TTL, well inside the error one
  await feed.refresh([repo('r')]);
  assert.equal(calls, 1, 'a failure is trusted for longer than a success');

  now += 20 * 60 * 1000;
  await feed.refresh([repo('r')]);
  assert.equal(calls, 2, 'but it does eventually retry');
});

test('treats "no CLI could answer" as a failure, not as an empty queue', async () => {
  // `null` and `[]` are different facts: the first is worth retrying slowly, the second is
  // the truth. Collapsing them would retry a quiet repo forever, or never retry a broken one.
  let calls = 0;
  let now = 1_000_000;
  const feed = createReviewFeed({
    list: async () => {
      calls += 1;
      return null;
    },
    now: () => now,
  });
  await feed.refresh([repo('r')]);
  now += 6 * 60 * 1000;
  await feed.refresh([repo('r')]);
  assert.equal(calls, 1, 'null is remembered on the error TTL');
});

test('forgets a repo that is no longer scanned', async () => {
  const feed = createReviewFeed({ list: async () => [item()] });
  await feed.refresh([repo('a'), repo('b')]);
  assert.equal(feed.snapshot().length, 2);
  await feed.refresh([repo('a')]);
  assert.equal(feed.snapshot().length, 1, 'a removed base dir must not leave rows behind');
});

test('an unchanged answer does not push a frame', async () => {
  // Same rule as ci.ts: a frame goes to every open client, so an identical snapshot is
  // not news.
  let now = 1_000_000;
  const feed = createReviewFeed({ list: async () => [item()], now: () => now });
  assert.equal(await feed.refresh([repo('r')]), true);
  now += 10 * 60 * 1000; // past the TTL, so it really does ask again
  assert.equal(await feed.refresh([repo('r')]), false, 'same answer, no frame');
});

test('one sweep at a time', async () => {
  let inFlight = 0;
  let peak = 0;
  const feed = createReviewFeed({
    list: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return [item()];
    },
  });
  await Promise.all([feed.refresh([repo('a')]), feed.refresh([repo('b')])]);
  assert.equal(peak, 1, 'two overlapping sweeps would double the subprocesses');
});
