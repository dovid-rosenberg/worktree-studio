import { test } from 'node:test';
import assert from 'node:assert';
import { deriveEnv } from '../server/concurrency.ts';

/*
 * The single job-scheduler rule, as code rather than as a sentence in MANUAL.md.
 *
 * "The job scheduler must only ever run in one stack" was a rule humans and agents had to
 * remember, and slots are handed out freely — so two features each ran a backend that
 * believed it was the scheduler. Duplicate scheduled jobs SUCCEED, twice; the report is a
 * doubled charge, hours later, with nothing logged as an error.
 */

const AB = {
  portEnv: { api__port: 1233 },
  slotEnv: ['redis__db'],
  scheduler: { env: 'job_schedule' },
};

test('slot 0 owns the scheduler by default', () => {
  assert.equal(deriveEnv(AB, 0, 100).env.job_schedule, 'true');
});

test('every other slot is told to stand down — the half that enforces the rule', () => {
  // Setting only the owner's value would leave slot 1 on the repo's own default, which
  // for a backend that runs jobs unless told otherwise IS the duplicate-jobs bug.
  assert.equal(deriveEnv(AB, 1, 100).env.job_schedule, 'false');
  assert.equal(deriveEnv(AB, 2, 100).env.job_schedule, 'false');
});

test('exactly one slot in a full house is the owner', () => {
  const owners = [0, 1, 2].filter((s) => deriveEnv(AB, s, 100).env.job_schedule === 'true');
  assert.deepEqual(owners, [0]);
});

test('a repo that declares no scheduler gets neither value — opt-in, byte for byte as before', () => {
  const plain = { portEnv: { api__port: 1233 }, slotEnv: ['redis__db'] };
  for (const slot of [0, 1, 2]) {
    assert.deepEqual(Object.keys(deriveEnv(plain, slot, 100).env).sort(), ['api__port', 'redis__db']);
  }
  assert.deepEqual(deriveEnv(null, 1, 100).env, {});
});

test('the variable NAME is configurable — the backend that reads it is not this repo', () => {
  const other = { scheduler: { env: 'RUN_SCHEDULED_JOBS' } };
  assert.equal(deriveEnv(other, 0, 100).env.RUN_SCHEDULED_JOBS, 'true');
  assert.equal(deriveEnv(other, 1, 100).env.RUN_SCHEDULED_JOBS, 'false');
  assert.equal(deriveEnv(other, 0, 100).env.job_schedule, undefined);
});

test('the on/off VALUES are configurable — not every backend reads true/false', () => {
  const c = { scheduler: { env: 'JOBS', on: '1', off: '0' } };
  assert.equal(deriveEnv(c, 0, 100).env.JOBS, '1');
  assert.equal(deriveEnv(c, 1, 100).env.JOBS, '0');
});

test('a repo can name a slot other than 0 as the owner', () => {
  const c = { scheduler: { env: 'JOBS', slot: 2 } };
  assert.deepEqual(
    [0, 1, 2].map((s) => deriveEnv(c, s, 100).env.JOBS),
    ['false', 'false', 'true'],
  );
});

test('the scheduler value is not a port and never lands in ports', () => {
  // ports drives the "is it listening" check; a boolean in there would be probed as one.
  assert.deepEqual(deriveEnv(AB, 1, 100).ports, [1333]);
});

test('scheduler rides alongside the port and slot env of the same slot', () => {
  assert.deepEqual(deriveEnv(AB, 1, 100).env, {
    api__port: '1333',
    redis__db: '1',
    job_schedule: 'false',
  });
});
