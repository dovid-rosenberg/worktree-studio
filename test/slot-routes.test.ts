/*
 * The slot routes.
 *
 * The assertion that matters most is `refuses ... WITHOUT stopping anything`: a move that
 * validates its target after tearing the feature down can leave you with a backend on the
 * new slot and a dead frontend, which is strictly worse than not moving at all.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { createServer } from 'node:http';
import { register } from '../server/orchestrator.ts';

/**
 * A router with orchestrator routes mounted over stub deps.
 *
 * `servers` is merged, not replaced — a trailing spread of the whole override object
 * would clobber the stub Servers with whichever one or two methods a test overrode.
 */
function app({ servers: serverOverrides = {}, ...overrides }: Record<string, any> = {}) {
  const a = express();
  a.use(express.json());
  const members = [
    { repo: 'accept-blue', path: '/wt/be', ports: [1231], running: true, canStart: true },
    { repo: 'ab-su', path: '/wt/su', ports: [8000], running: true, canStart: true },
  ];
  const deps = {
    cfg: { concurrency: { enabled: true, offsetStep: 100, maxSlots: 3, repos: {} }, editors: {} },
    saveConfig: () => {},
    manager: {},
    repos: () => [],
    conflictsFor: () => [],
    refreshRunning: async () => {},
    running: () => new Map(),
    scheduleBroadcast: () => {},
    rescan: async () => {},
    ...overrides,
    resolveGroup:
      overrides.resolveGroup ??
      (async (name: string) =>
        name === 'f' ? { group: { name: 'f', members }, flat: members } : { group: null, flat: [] }),
    servers: {
      featureFor: () => 'f',
      slotReport: async () => [
        { slot: 0, state: 'blocked', ports: {}, blockedBy: { port: 1231, pid: 54549 } },
        { slot: 1, state: 'free', ports: {} },
        { slot: 2, state: 'current', ports: {} },
      ],
      slots: new Map([['f', 2]]),
      stop: async () => ({ ok: true }),
      releaseSlot: () => {},
      releaseSlotIfIdle: () => true,
      allocSlotFor: async () => ({ slot: 1 }),
      startAll: async () => ({ ok: true, results: [] }),
      launchOpts: () => ({}),
      restart: async () => ({ ok: true, log: '' }),
      ...serverOverrides,
    },
  };
  register(a, deps as never);
  return a;
}

async function call(a: express.Express, method: string, url: string, body?: unknown) {
  const srv = createServer(a);
  await new Promise<void>((r) => srv.listen(0, () => r()));
  const { port } = srv.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as any;
  srv.close();
  return { status: res.status, json };
}

test('GET /group/:name/slots returns the report', async () => {
  const r = await call(app(), 'GET', '/group/f/slots');
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 3);
  assert.equal(r.json[0].state, 'blocked');
  assert.deepEqual(r.json[0].blockedBy, { port: 1231, pid: 54549 });
});

test('GET /group/:name/slots 404s for an unknown feature', async () => {
  const r = await call(app(), 'GET', '/group/nope/slots');
  assert.equal(r.status, 404);
});

test('POST /group/slot refuses an unavailable slot WITHOUT stopping anything', async () => {
  let stopped = 0;
  const a = app({
    servers: {
      stop: async () => {
        stopped++;
        return { ok: true };
      },
    },
  });
  const r = await call(a, 'POST', '/group/slot', { group: 'f', slot: 0 }); // slot 0 is blocked
  assert.equal(r.status, 409);
  assert.match(String(r.json.error), /54549/);
  assert.equal(stopped, 0, 'nothing may be stopped before the target is known good');
});

test('POST /group/slot stops, re-allocates, and restarts on the new slot', async () => {
  const order: string[] = [];
  const a = app({
    servers: {
      stop: async () => {
        order.push('stop');
        return { ok: true };
      },
      releaseSlot: () => order.push('release'),
      allocSlotFor: async (_f: string, o: { requested?: number }) => {
        order.push(`alloc:${o?.requested}`);
        return { slot: o?.requested ?? 0 };
      },
      startAll: async () => {
        order.push('start');
        return { ok: true, results: [] };
      },
    },
  });
  const r = await call(a, 'POST', '/group/slot', { group: 'f', slot: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(order, ['stop', 'stop', 'release', 'alloc:1', 'start']);
});

test('POST /group/slot 409s if the slot is taken during the stop', async () => {
  const a = app({
    servers: { allocSlotFor: async () => ({ error: 'slot 1 is held by other' }) },
  });
  const r = await call(a, 'POST', '/group/slot', { group: 'f', slot: 1 });
  assert.equal(r.status, 409);
  assert.match(String(r.json.error), /held by other/);
});

test('POST /group/slot rejects a non-integer slot', async () => {
  const r = await call(app(), 'POST', '/group/slot', { group: 'f', slot: 'x' });
  assert.equal(r.status, 400);
});

test('POST /group/slot is a no-op for the slot the feature is already on', async () => {
  let stopped = 0;
  const a = app({
    servers: {
      stop: async () => {
        stopped++;
        return { ok: true };
      },
    },
  });
  const r = await call(a, 'POST', '/group/slot', { group: 'f', slot: 2 }); // slot 2 is current
  assert.equal(r.status, 200);
  assert.equal(stopped, 0);
});

test('POST /group/start forwards slot to startAll', async () => {
  let got: unknown;
  const a = app({
    servers: {
      startAll: async (_t: unknown, o: { slot?: number }) => {
        got = o?.slot;
        return { ok: true, results: [] };
      },
    },
  });
  await call(a, 'POST', '/group/start', { group: 'f', slot: 2 });
  assert.equal(got, 2);
});

test('POST /group/start with no slot forwards undefined', async () => {
  let got: unknown = 'unset';
  const a = app({
    servers: {
      startAll: async (_t: unknown, o: { slot?: number }) => {
        got = o?.slot;
        return { ok: true, results: [] };
      },
    },
  });
  await call(a, 'POST', '/group/start', { group: 'f' });
  assert.equal(got, undefined, 'the default path must not pin slot 0');
});
