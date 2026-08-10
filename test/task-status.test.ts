/*
 * Ticket status — the one part of a link that needs an API rather than a pattern.
 *
 * server/links.ts resolves a label and a glyph from the URL alone, deliberately, so that
 * display needs no auth. A STATUS lives on the tracker's server, so it needs a token and
 * a round trip — which is why it is cached hard and why a failure has to be remembered as
 * a failure. Without that last part, a tracker that is down means every sweep retries
 * every ticket forever, and the only symptom is hundreds of doomed requests an hour.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createTaskStatusFeed } from '../server/task-status.ts';

const FEATS = [
  { name: 'alpha', ticket: 'https://app.asana.com/0/1/111' },
  { name: 'beta', ticket: 'https://app.asana.com/0/1/222' },
];

test('a resolved status lands in the snapshot', async () => {
  const feed = createTaskStatusFeed({
    cfg: {} as never,
    resolve: async () => ({ label: 'In Progress', done: false }),
  });
  assert.equal(await feed.refresh(FEATS), true, 'something changed');
  assert.deepEqual(feed.snapshot().alpha, { label: 'In Progress', done: false });
});

test('a feature with NO ticket is never fetched', async () => {
  let calls = 0;
  const feed = createTaskStatusFeed({
    cfg: {} as never,
    resolve: async () => {
      calls++;
      return { label: 'x', done: false };
    },
  });
  await feed.refresh([{ name: 'no-ticket' }]);
  assert.equal(calls, 0, 'nothing to ask about');
  assert.deepEqual(feed.snapshot(), {});
});

test('a fresh entry is NOT re-fetched — the whole point of the cache', async () => {
  let calls = 0;
  const feed = createTaskStatusFeed({
    cfg: {} as never,
    resolve: async () => {
      calls++;
      return { label: 'Backlog', done: false };
    },
  });
  await feed.refresh(FEATS);
  assert.equal(calls, 2);
  await feed.refresh(FEATS);
  assert.equal(calls, 2, 'a human moving a card is not a fast event');
});

test('a STALE entry is re-fetched once the TTL passes', async () => {
  let calls = 0;
  let clock = 0;
  const feed = createTaskStatusFeed({
    cfg: {} as never,
    now: () => clock,
    resolve: async () => {
      calls++;
      return { label: 'Backlog', done: false };
    },
  });
  await feed.refresh([FEATS[0]]);
  assert.equal(calls, 1);
  clock += 11 * 60 * 1000;
  await feed.refresh([FEATS[0]]);
  assert.equal(calls, 2);
});

test('a FAILURE is remembered, so an outage is not hammered', async () => {
  let calls = 0;
  let clock = 0;
  const feed = createTaskStatusFeed({
    cfg: {} as never,
    now: () => clock,
    resolve: async () => {
      calls++;
      throw new Error('Asana API 503');
    },
  });
  await feed.refresh([FEATS[0]]);
  assert.equal(calls, 1);

  // Immediately after: not retried.
  await feed.refresh([FEATS[0]]);
  assert.equal(calls, 1, 'a tracker that is down must not be asked again every sweep');

  // After the shorter error TTL: retried, because outages end.
  clock += 6 * 60 * 1000;
  await feed.refresh([FEATS[0]]);
  assert.equal(calls, 2);
});

test('one failing ticket does not stop the others', async () => {
  const feed = createTaskStatusFeed({
    cfg: {} as never,
    resolve: async (_c, url) => {
      if (url.endsWith('111')) throw new Error('nope');
      return { label: 'Done', done: true };
    },
  });
  await feed.refresh(FEATS);
  assert.equal(feed.snapshot().alpha, undefined);
  assert.deepEqual(feed.snapshot().beta, { label: 'Done', done: true });
});

test('refresh reports whether anything actually CHANGED', async () => {
  // The caller broadcasts on true, so a sweep that found the same answers must say false
  // or every poll would push a frame to every client for nothing.
  let label = 'Backlog';
  let clock = 0;
  const feed = createTaskStatusFeed({
    cfg: {} as never,
    now: () => clock,
    resolve: async () => ({ label, done: false }),
  });
  assert.equal(await feed.refresh([FEATS[0]]), true);

  clock += 11 * 60 * 1000;
  assert.equal(await feed.refresh([FEATS[0]]), false, 'same answer, no broadcast');

  label = 'In Progress';
  clock += 11 * 60 * 1000;
  assert.equal(await feed.refresh([FEATS[0]]), true);
});

test('a deleted feature is forgotten, so the map cannot grow forever', async () => {
  const feed = createTaskStatusFeed({ cfg: {} as never, resolve: async () => ({ label: 'x', done: false }) });
  await feed.refresh(FEATS);
  feed.forget('alpha');
  assert.equal(feed.snapshot().alpha, undefined);
  assert.ok(feed.snapshot().beta);
});
