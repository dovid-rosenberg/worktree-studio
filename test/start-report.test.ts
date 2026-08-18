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
import { describeOwner, portBusy, report, skipReason, toSkip, toStart } from '../server/start-report.ts';

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

/*
 * A busy port names its HOLDER.
 *
 * "port 1233 already in use (pid 4711)" ends the user's information and starts their
 * investigation: ps, lsof -p, then work out which worktree that path is. The daemon has
 * already done that walk — _resolvePid maps a pid to the git worktree it runs in, which is
 * how the running-server scan attributes servers at all — so the only thing missing was
 * carrying the answer into the sentence.
 */
test('a busy port is described by who holds it, when that is known', () => {
  assert.equal(
    portBusy(1233, { pid: 4711, feature: 'auth-refresh', repo: 'api' }),
    'port 1233 is held by auth-refresh (api, pid 4711)',
  );
  // The pid survives the upgrade: it is what the user types into `kill` after reading it.
  assert.equal(
    portBusy(1233, { pid: 4711, feature: 'auth-refresh' }),
    'port 1233 is held by auth-refresh (pid 4711)',
  );
  assert.equal(
    portBusy(1233, { feature: 'auth-refresh', repo: 'api' }),
    'port 1233 is held by auth-refresh (api)',
  );
});

test('an UNKNOWN owner keeps the old sentence rather than inventing one', () => {
  // A pid outside any git worktree resolves to nothing, and half the holders of a port are
  // not dev servers at all. Claiming less is the correct answer, not a degraded one.
  assert.equal(portBusy(1233, { pid: 4711 }), 'port 1233 already in use (pid 4711)');
  assert.equal(portBusy(1233, null), 'port 1233 already in use');
  assert.equal(portBusy(1233, {}), 'port 1233 already in use');
  assert.equal(describeOwner(null), '', 'nothing known appends nothing — no "held by unknown"');
});

test('bound-elsewhere names the port it SHOULD have used, and its holder', () => {
  // The message named only the wrong port, so the number the user needs in order to look —
  // and the feature already sitting on it — was the part that was missing.
  const r = report([
    {
      repo: 'api',
      ok: true,
      listening: false,
      boundElsewhere: [3000],
      wantedPort: 1233,
      portOwner: { pid: 4711, feature: 'auth-refresh', repo: 'api' },
    },
  ]);
  const err = r.failures[0].error || '';
  assert.match(err, /3000/, 'still says where it actually bound');
  assert.match(err, /Port 1233 is held by auth-refresh \(api, pid 4711\)/);
});

test('bound-elsewhere with no resolvable holder still names the expected port', () => {
  const r = report([{ repo: 'api', ok: true, listening: false, boundElsewhere: [3000], wantedPort: 1233 }]);
  const err = r.failures[0].error || '';
  assert.match(err, /Its slot expects port 1233/);
  assert.doesNotMatch(err, /held by/);
});

test('an already-running member is neither started nor skipped', () => {
  const members = [m('api', { running: true }), m('fe')];
  assert.deepEqual(
    toStart(members).map((x) => x.repo),
    ['fe'],
  );
  assert.deepEqual(toSkip(members), [], 'running is not a shortfall');
});
