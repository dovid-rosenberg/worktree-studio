'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { deriveEnv, allocSlot } = require('../server/concurrency');

// accept-blue's real port map + redis__db slot key (mirrors config defaults).
const AB = {
  portEnv: { api__port_su: 1231, api__port_iso: 1232, api__port: 1233, api__port_merchant: 1239, api__port_internal: 1999 },
  slotEnv: ['redis__db'],
};

test('deriveEnv slot 0 leaves ports at their base and redis__db at 0', () => {
  const { env } = deriveEnv(AB, 0, 100);
  assert.deepEqual(env, {
    api__port_su: '1231', api__port_iso: '1232', api__port: '1233',
    api__port_merchant: '1239', api__port_internal: '1999', redis__db: '0',
  });
});

test('deriveEnv slot 1 offsets every port by +100 and sets redis__db to 1', () => {
  const { env } = deriveEnv(AB, 1, 100);
  assert.deepEqual(env, {
    api__port_su: '1331', api__port_iso: '1332', api__port: '1333',
    api__port_merchant: '1339', api__port_internal: '2099', redis__db: '1',
  });
});

test('deriveEnv slot 2 offsets every port by +200 and sets redis__db to 2', () => {
  const { env } = deriveEnv(AB, 2, 100);
  assert.deepEqual(env, {
    api__port_su: '1431', api__port_iso: '1432', api__port: '1433',
    api__port_merchant: '1439', api__port_internal: '2199', redis__db: '2',
  });
});

test('deriveEnv returns the offset ports array (not the slotEnv key)', () => {
  const { ports } = deriveEnv(AB, 1, 100);
  assert.deepEqual(ports, [1331, 1332, 1333, 1339, 2099]);
});

test('deriveEnv env values are strings', () => {
  const { env } = deriveEnv(AB, 1, 100);
  assert.equal(typeof env.api__port_su, 'string');
  assert.equal(typeof env.redis__db, 'string');
});

test('allocSlot returns the lowest free slot', () => {
  assert.equal(allocSlot(new Set(), 3), 0);
});

test('allocSlot skips used slots and returns the next free one', () => {
  assert.equal(allocSlot(new Set([0, 1]), 3), 2);
});

test('allocSlot fills a hole left by a released slot', () => {
  assert.equal(allocSlot(new Set([0, 2]), 3), 1);
});

test('allocSlot returns null when all slots are busy', () => {
  assert.equal(allocSlot(new Set([0, 1, 2]), 3), null);
});

test('allocSlot accepts an array of used slots', () => {
  assert.equal(allocSlot([0, 1], 3), 2);
});
