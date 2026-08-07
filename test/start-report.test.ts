/*
 * The one judgement both start routes now make.
 *
 * `/group/start` and `/sessions/:id/servers/start` were independent implementations of
 * the same rule, and only the first was ever fixed — so pressing the session's button
 * reproduced, exactly, the "the BE does not seem to be running" report the group route
 * had been hardened against. These pin the three properties that made the difference.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { report, skipReason, toSkip, toStart } from '../server/start-report.ts';

const m = (repo: string, over: Record<string, unknown> = {}) => ({
  repo,
  path: `/code/${repo}/wt`,
  running: false,
  canStart: true,
  ...over,
});

test('a member that CANNOT start is named, not silently dropped', () => {
  // The original bug: a two-repo feature whose BE worktree has no node_modules answered
  // {ok:true, started:1, total:1} — byte-identical to a full success.
  const members = [m('api'), m('fe', { canStart: false, depsMissing: true })];
  assert.deepEqual(
    toStart(members).map((x) => x.repo),
    ['api'],
  );
  assert.deepEqual(toSkip(members), [
    { repo: 'fe', path: '/code/fe/wt', reason: 'dependencies not installed' },
  ]);

  const r = report([{ repo: 'api', ok: true }], toSkip(members));
  assert.equal(r.ok, false, 'half a stack is not a success');
  assert.equal(r.started, 1);
  assert.equal(r.total, 2, 'total counts what SHOULD be up, so the shortfall is visible');
});

test('the two reasons canStart is false are distinguished, because the fixes differ', () => {
  assert.equal(skipReason(m('x', { depsMissing: true })), 'dependencies not installed');
  assert.equal(skipReason(m('x', { noStartCmd: true })), 'no start command configured for this repo');
  // Deps first: a repo with neither is fixed by installing before the command matters.
  assert.equal(skipReason(m('x', { depsMissing: true, noStartCmd: true })), 'dependencies not installed');
});

test('ok is EVERY member, not some — one of three coming up is not a win', () => {
  const r = report([
    { repo: 'api', ok: true },
    { repo: 'fe', ok: false, error: 'boom' },
    { repo: 'su', ok: false, error: 'nope' },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.started, 1);
  assert.deepEqual(
    r.failures.map((f) => f.repo),
    ['fe', 'su'],
  );
});

test('spawned but never listening is a FAILURE, and says which kind', () => {
  // The exact shape of "it said it started and nothing is running": the process was
  // created, so `ok` was true, and whether it ever bound a port was never asked.
  const down = report([{ repo: 'api', ok: true, listening: false }]);
  assert.equal(down.ok, false);
  assert.equal(down.started, 0);
  assert.match(down.failures[0].error || '', /no port was listening/);

  // Bound somewhere unexpected is a DIFFERENT diagnosis: it is up and misconfigured,
  // which is why a second feature cannot run it.
  const elsewhere = report([{ repo: 'api', ok: true, listening: false, boundElsewhere: [3000] }]);
  assert.match(elsewhere.failures[0].error || '', /port env var/);
  assert.match(elsewhere.failures[0].error || '', /3000/);
});

test('listening undefined — not checked — is not held against a start', () => {
  const r = report([{ repo: 'api', ok: true }]);
  assert.equal(r.ok, true);
  assert.equal(r.started, 1);
});

test('nothing to start is ok: that is a no-op, not a failure', () => {
  assert.deepEqual(report([], []), { ok: true, started: 0, total: 0, skipped: [], failures: [] });
});

test('an already-running member is neither started nor skipped', () => {
  const members = [m('api', { running: true }), m('fe')];
  assert.deepEqual(
    toStart(members).map((x) => x.repo),
    ['fe'],
  );
  assert.deepEqual(toSkip(members), [], 'running is not a shortfall');
});
