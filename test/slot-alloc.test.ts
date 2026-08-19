/*
 * Slot allocation: what the user asked for, or a reason.
 *
 * The rule that shapes every case below is that a REQUESTED slot is never silently
 * substituted. Handing back a different slot than the one named would defeat the point of
 * naming one, and the caller would only find out by reading ports afterwards.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Servers } from '../server/servers.ts';

const CONC = {
  enabled: true,
  offsetStep: 100,
  maxSlots: 3,
  repos: { 'accept-blue': { portEnv: { api__port_su: 1231 } } },
};

function servers(bound: Record<number, number> = {}, extraConc = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-slotalloc-'));
  const s = new Servers({
    _stateDir: stateDir,
    web: { port: 0 },
    start: { 'accept-blue': { cmd: ':', ports: [] }, 'ab-su': { cmd: ':', ports: [] } },
    concurrency: { ...CONC, ...extraConc },
  } as never);
  s.portPid = async (port: number) => bound[port] ?? null;
  return s;
}

const BE = [{ repo: 'accept-blue', worktreePath: '/wt/be' }];

test('a feature that already holds a slot keeps it', async () => {
  const s = servers();
  s.slots.set('f', 2);
  assert.deepEqual(await s.allocSlotFor('f', { members: BE }), { slot: 2 });
});

test('default policy skips a slot whose ports are bound', async () => {
  const s = servers({ 1231: 54549 });
  assert.deepEqual(await s.allocSlotFor('f', { members: BE }), { slot: 1 });
});

test('default policy skips a held slot too', async () => {
  const s = servers();
  s.slots.set('other', 0);
  assert.deepEqual(await s.allocSlotFor('f', { members: BE }), { slot: 1 });
});

test('a free requested slot is honored', async () => {
  const s = servers();
  assert.deepEqual(await s.allocSlotFor('f', { requested: 2, members: BE }), { slot: 2 });
  assert.equal(s.slots.get('f'), 2);
});

test('a held requested slot is refused and names the holder', async () => {
  const s = servers();
  s.slots.set('iso-mfa-totp', 1);
  const r = await s.allocSlotFor('f', { requested: 1, members: BE });
  assert.match(String(r.error), /held by iso-mfa-totp/);
  assert.equal(r.slot, undefined);
  assert.equal(s.slots.has('f'), false, 'a refused request allocates nothing');
});

test('a blocked requested slot is refused and names port and pid', async () => {
  const s = servers({ 1231: 54549 });
  const r = await s.allocSlotFor('f', { requested: 0, members: BE });
  assert.match(String(r.error), /1231/);
  assert.match(String(r.error), /54549/);
});

test('a requested slot is never silently substituted', async () => {
  const s = servers({ 1231: 54549 });
  const r = await s.allocSlotFor('f', { requested: 0, members: BE });
  assert.equal(r.slot, undefined, 'refuse, do not hand back slot 1');
});

test('an out-of-range request is refused', async () => {
  const r = await servers().allocSlotFor('f', { requested: 7, members: BE });
  assert.match(String(r.error), /does not exist/);
});

test('every slot blocked falls back to the lowest unheld slot rather than refusing', async () => {
  const s = servers({ 1231: 1, 1331: 2, 1431: 3 });
  assert.deepEqual(await s.allocSlotFor('f', { members: BE }), { slot: 0 });
});

test('all slots held is still an error', async () => {
  const s = servers();
  s.slots.set('a', 0);
  s.slots.set('b', 1);
  s.slots.set('c', 2);
  const r = await s.allocSlotFor('f', { members: BE });
  assert.match(String(r.error), /no free concurrency slot/);
});

test("policy 'lowest' ignores bound ports", async () => {
  const s = servers({ 1231: 54549 }, { slotPolicy: 'lowest' });
  assert.deepEqual(await s.allocSlotFor('f', { members: BE }), { slot: 0 });
});

test('concurrency off answers slot 0', async () => {
  const s = servers({}, { enabled: false });
  assert.deepEqual(await s.allocSlotFor('f', { members: BE }), { slot: 0 });
});

test('no members behaves as today — lowest unheld slot', async () => {
  const s = servers({ 1231: 54549 });
  s.slots.set('other', 0);
  assert.deepEqual(await s.allocSlotFor('f', {}), { slot: 1 });
});

// ---- startAll (Task 3) ----

test('startAll allocates every slot before launching anything', async () => {
  const s = servers();
  s.slots.set('a', 0);
  s.slots.set('b', 1);
  s.slots.set('c', 2);
  let launched = 0;
  s.start = async () => {
    launched++;
    return { ok: true, log: '' };
  };
  s.featureFor = () => 'f';
  const out = await s.startAll([{ repo: 'accept-blue', worktreePath: '/wt/be' }]);
  assert.equal(out.ok, false);
  assert.equal(launched, 0, 'a refused slot spawns nothing');
});

test('startAll passes a requested slot through and refuses cleanly', async () => {
  const s = servers({ 1231: 54549 });
  let launched = 0;
  s.start = async () => {
    launched++;
    return { ok: true, log: '' };
  };
  s.featureFor = () => 'f';
  const out = await s.startAll([{ repo: 'accept-blue', worktreePath: '/wt/be' }], { slot: 0 });
  assert.equal(out.ok, false);
  assert.match(String(out.ok === false ? out.slotError : ''), /54549/);
  assert.equal(launched, 0);
});

test('startAll allocates once per feature, not once per target', async () => {
  const s = servers();
  s.start = async () => ({ ok: true, log: '' });
  s.featureFor = () => 'f';
  const out = await s.startAll(
    [
      { repo: 'accept-blue', worktreePath: '/wt/be' },
      { repo: 'ab-su', worktreePath: '/wt/su' },
    ],
    { slot: 2 },
  );
  assert.equal(out.ok, true);
  assert.equal(s.slots.get('f'), 2);
});
