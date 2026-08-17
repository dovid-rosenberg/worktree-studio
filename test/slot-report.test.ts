/*
 * Per-feature slot availability.
 *
 * The load-bearing case is the last one: a slot is not occupied in the abstract. It is
 * occupied for a FEATURE, judged against the ports that feature's repos actually derive.
 * An FE-only feature is happy on a slot whose backend ports are taken, because it never
 * binds them — and a global occupancy model greys out exactly that start.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Servers } from '../server/servers.ts';

// accept-blue + ab-su, the real shape of a two-repo feature.
const CONC = {
  enabled: true,
  offsetStep: 100,
  maxSlots: 3,
  repos: {
    'accept-blue': {
      portEnv: { api__port_su: 1231, api__port: 1233 },
      slotEnv: ['redis__db'],
    },
    'ab-su': { portEnv: { WTS_FE_PORT: 8000 } },
  },
};

/**
 * A Servers with concurrency configured and `portPid` stubbed.
 * `bound` maps port → pid; anything absent reads as free.
 */
function servers(bound: Record<number, number> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-slotrep-'));
  const s = new Servers({
    _stateDir: stateDir,
    web: { port: 0 },
    start: { 'accept-blue': { cmd: ':', ports: [] }, 'ab-su': { cmd: ':', ports: [] } },
    concurrency: CONC,
  } as never);
  s.portPid = async (port: number) => bound[port] ?? null;
  return s;
}

const BE = { repo: 'accept-blue', worktreePath: '/wt/be' };
const SU = { repo: 'ab-su', worktreePath: '/wt/su' };

test('slotReport derives each repo ports per slot', async () => {
  const r = await servers().slotReport('f', [BE, SU]);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0].ports, { 'accept-blue': [1231, 1233], 'ab-su': [8000] });
  assert.deepEqual(r[2].ports, { 'accept-blue': [1431, 1433], 'ab-su': [8200] });
});

test('a slot whose ports are all unbound is free', async () => {
  const r = await servers().slotReport('f', [BE, SU]);
  assert.deepEqual(
    r.map((x) => x.state),
    ['free', 'free', 'free'],
  );
});

test('a slot another feature holds is held, and names it', async () => {
  const s = servers();
  s.slots.set('iso-mfa-totp', 1);
  const r = await s.slotReport('f', [BE, SU]);
  assert.equal(r[1].state, 'held');
  assert.equal(r[1].heldBy, 'iso-mfa-totp');
});

test("the feature's own slot is current, not held", async () => {
  const s = servers();
  s.slots.set('f', 2);
  const r = await s.slotReport('f', [BE, SU]);
  assert.equal(r[2].state, 'current');
  assert.equal(r[2].heldBy, undefined);
});

test('an unheld slot with a bound port is blocked, and names port and pid', async () => {
  const r = await servers({ 1231: 54549 }).slotReport('f', [BE, SU]);
  assert.equal(r[0].state, 'blocked');
  assert.deepEqual(r[0].blockedBy, { port: 1231, pid: 54549 });
  assert.equal(r[1].state, 'free');
});

// The case a global occupancy model gets wrong, and the reason this API takes members.
test('a bound port belonging to a repo NOT in this feature leaves the slot free', async () => {
  const r = await servers({ 1231: 54549 }).slotReport('su-mfa-cleanup', [SU]);
  assert.equal(r[0].state, 'free', 'ab-su only needs 8000 on slot 0');
  assert.deepEqual(r[0].ports, { 'ab-su': [8000] });
});

test('held beats blocked — a held slot is not port-probed', async () => {
  const s = servers({ 1331: 999 });
  s.slots.set('other', 1);
  const r = await s.slotReport('f', [BE]);
  assert.equal(r[1].state, 'held');
  assert.equal(r[1].blockedBy, undefined);
});

test('a repo with no concurrency config contributes no ports', async () => {
  const r = await servers().slotReport('f', [{ repo: 'unmapped', worktreePath: '/wt/x' }]);
  assert.deepEqual(r[0].ports, {});
  assert.equal(r[0].state, 'free');
});
