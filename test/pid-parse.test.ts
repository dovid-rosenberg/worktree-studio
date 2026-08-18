/*
 * The ownership proof that stands between stop() and a SIGKILL.
 *
 * `_psInfo` and `_resolvePid` are pure text parsing wrapped around two spawns, and what
 * they parse is the ONLY thing separating "this pid is the dev server we launched" from
 * "this pid is whatever the kernel handed the number to after a reboot". _trackedPidState
 * compares the start time _psInfo reads; the legacy branch falls back to the worktree
 * _resolvePid reads. Both then decide who gets signalled — stop() sends SIGTERM, and later
 * SIGKILL, to the process GROUP.
 *
 * So the rule these tests hold the parsers to is not "parse everything". It is: output you
 * do not recognise must produce NULL, because null means 'gone'/'stranger' and both of
 * those mean leave it alone. A wrong answer here kills somebody else's process.
 *
 * They are table-driven over captured real output rather than mocked at the function
 * boundary, because the failure mode being guarded is precisely a shape of real output
 * nobody anticipated. `ps` and `lsof` are stubbed by putting scripts of those names first
 * on PATH — hence the dynamic import below: server/util.ts snapshots PATH into CHILD_ENV
 * at module load, so it has to be set before servers.ts is pulled in. `git` is NOT stubbed;
 * the worktree cases run against real repositories on disk.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-fakebin-'));
const out = (name: string) => path.join(fake, `${name}.out`);
for (const name of ['ps', 'lsof']) {
  // Exits 0 with whatever the fixture file holds — including nothing, which is how both
  // tools answer for a pid that has gone.
  fs.writeFileSync(path.join(fake, name), `#!/bin/sh\ncat ${out(name)} 2>/dev/null\nexit 0\n`);
  fs.chmodSync(path.join(fake, name), 0o755);
}
const say = (name: 'ps' | 'lsof', text: string) => fs.writeFileSync(out(name), text);
process.env.PATH = `${fake}:${process.env.PATH || ''}`;

const { Servers } = await import('../server/servers.ts');
const { realpath } = await import('../server/util.ts');

function servers() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-pidparse-'));
  return new Servers({ _stateDir: stateDir, web: { port: 0 }, start: {} });
}

function sh(cwd: string, cmd: string, args: string[]): void {
  execFileSync(cmd, args, { cwd, stdio: 'ignore' });
}

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-pidrepo-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 't@t.t']);
  sh(dir, 'git', ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  sh(dir, 'git', ['add', '.']);
  sh(dir, 'git', ['commit', '-q', '-m', 'init']);
  return dir;
}

// ---- _psInfo -----------------------------------------------------------------------

test('_psInfo reads a real macOS `ps -o lstart=,command=` line', async () => {
  const s = servers();
  say('ps', 'Mon Jul 27 22:46:40 2026 node /Users/d/code/api/.worktrees/auth/node_modules/.bin/vite\n');
  const info = await s._psInfo(4711);
  assert.equal(info?.startedAt, Date.parse('Mon Jul 27 22:46:40 2026'));
  // The command must survive intact: the legacy branch of _trackedPidState substring-matches
  // the configured start command against it, and a truncated one silently means 'stranger'.
  assert.equal(info?.command, 'node /Users/d/code/api/.worktrees/auth/node_modules/.bin/vite');
});

test('_psInfo answers null for output that names no process', async () => {
  const s = servers();
  for (const [what, text] of [
    ['a pid that is gone — ps prints nothing', ''],
    ['a lone newline', '\n'],
    ['whitespace only', '   \n  \n'],
    ['an error line where a record was expected', 'ps: no such process\n'],
  ] as const) {
    say('ps', text);
    assert.equal(await s._psInfo(4711), null, what);
  }
});

/*
 * A padded or locale-shifted `lstart` must be REJECTED, not misread.
 *
 * This was a real defect, and the reason it needed a test is that the old parse did not
 * fail on it. `_psInfo` took the timestamp with `line.slice(0, 24)` — the width of a
 * ctime in the C locale — and two ordinary situations make that field wider or shifted:
 * GNU ps right-aligns a column to its widest row, and nothing pinned LC_ALL, so a
 * non-English locale writes weekday and month names of a different length.
 *
 * `Date.parse` is lenient enough to accept the truncated remains. One leading space gave
 * the year 202; two gave 2020 — a plausible timestamp nothing downstream could tell from
 * a genuine reading of a six-year-old process — and the digits pushed off the end came
 * back glued to the front of the command. `_trackedPidState` then compared that against
 * the `Date.now()` stamped at spawn and called the daemon's own dev server a 'stranger'.
 * Safe in direction, since a stranger is never signalled, but on such a machine Studio
 * could never stop a server it started: the record was pruned and the process orphaned
 * with its port still held.
 *
 * `_psInfo` now anchors on the shape of a ctime and ENV pins LC_ALL=C. A field that does
 * not match is null — "I could not read this" — which every caller already handles.
 */
test('a padded or shifted lstart is rejected rather than misread', async () => {
  const s = servers();

  say('ps', ' Mon Jul 27 22:46:40 2026 node dev\n'); // one column of GNU padding
  assert.notEqual(await s._psInfo(4711), null, 'leading padding is still a readable ctime');

  say('ps', '  Mon Jul  6 09:05:00 2026 node dev\n');
  const two = await s._psInfo(4711);
  assert.equal(new Date(two!.startedAt).getUTCFullYear(), 2026, 'the year is the real one, not 2020');
  assert.equal(two!.command, 'node dev', 'and no digit of it leaks into the command');

  // A locale that writes a longer month name does not fit the C-locale shape at all.
  // Rejected outright, which is the honest answer: LC_ALL=C means we should never see it.
  say('ps', 'lun. juil. 27 22:46:40 2026 node dev\n');
  assert.equal(await s._psInfo(4711), null, 'an unrecognised time format is not guessed at');
});

// ---- _resolvePid -------------------------------------------------------------------

test('_resolvePid maps a pid to the git worktree top-level it runs in', async () => {
  const s = servers();
  const repo = tempRepo();
  const sub = path.join(repo, 'nested');
  fs.mkdirSync(sub);
  // `lsof -Fn` output: a `p` line opens the process block, `n` carries the cwd.
  say('lsof', `p4711\nfcwd\nn${sub}\n`);
  const info = await s._resolvePid('4711');
  assert.equal(info?.cwd, sub);
  assert.equal(info?.top, realpath(repo), 'the worktree, not the cwd — that is what a record is filed under');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('_resolvePid answers null for anything it cannot place', async () => {
  const s = servers();
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-norepo-'));
  const cases: Array<[string, string]> = [
    // No `n` line at all: the pid exited between the LISTEN scan and this lookup, or lsof
    // could not read it (another user's process). Either way there is nothing to own.
    ['a pid with no cwd line', 'p4711\nfcwd\n'],
    ['no output whatsoever', ''],
    ['a process block and nothing else', 'p4711\n'],
    // lsof warns on stderr and can still print a header-ish line; none of it starts with n.
    ['only lsof chatter', "lsof: WARNING: can't stat() nfs file system\n"],
    // A cwd that exists but is not in any git checkout — a stray node process, a system
    // daemon. `git rev-parse` exits non-zero and the pid must stay unattributed: this is
    // the check that stops a stranger being filed under, and stopped as, a worktree.
    ['a cwd outside any git repo', `p4711\nfcwd\nn${notARepo}\n`],
    // A cwd that is not there at all — the directory was deleted under a running process.
    ['a cwd that no longer exists', `p4711\nfcwd\nn${path.join(notARepo, 'gone')}\n`],
  ];
  for (const [what, text] of cases) {
    say('lsof', text);
    assert.equal(await s._resolvePid('4711'), null, what);
  }
  fs.rmSync(notARepo, { recursive: true, force: true });
});
