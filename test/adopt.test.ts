// server/adopt.ts: healing worktrees Studio did not create.
//
// The scan already FINDS them — `git worktree list` does not care who ran it, so a
// worktree an agent made by hand is in the topology and grouped into its feature
// already. What it does not have is the files the copy step only ever ran inside
// create(): run configs and gitignored local config. These tests are about that gap,
// and about not re-doing the work on every scan.
import { test } from 'node:test';
import assert from 'node:assert';
import { createAdopter } from '../server/adopt.ts';
import type { ScannedRepo } from '../server/git.ts';

/** A scan result with one main checkout and however many worktrees. */
function scanned(worktrees: string[], repo = 'alpha'): ScannedRepo[] {
  const wt = (p: string, isMain: boolean) => ({
    path: p,
    head: 'abc',
    branch: 'feature/x',
    detached: false,
    bare: false,
    isMain,
    name: p.split('/').pop() || p,
    merged: false,
    ahead: 0,
  });
  return [
    {
      name: repo,
      path: `/repos/${repo}`,
      defaultBranch: 'main',
      defaultHead: 'abc',
      worktrees: [wt(`/repos/${repo}`, true), ...worktrees.map((p) => wt(p, false))],
    },
  ];
}

/** An adopter whose backfill is a spy, so a test can see exactly what it was asked to heal. */
function adopter(counts: { runConfigs: number; files: number } = { runConfigs: 1, files: 2 }) {
  const calls: Array<{ repoPath: string; dest: string }> = [];
  const adopt = createAdopter({
    cfg: { copyPatterns: { default: ['.env'] }, copyAlways: { default: ['.idea/*.xml'] } },
    backfill: async (repoPath: string, dest: string) => {
      calls.push({ repoPath, dest });
      return counts;
    },
  });
  return { adopt, calls };
}

test('a worktree the scan has not seen before is backfilled', async () => {
  const { adopt, calls } = adopter();
  const report = await adopt(scanned(['/repos/alpha/.worktrees/by-hand']));
  assert.deepEqual(
    calls.map((c) => c.dest),
    ['/repos/alpha/.worktrees/by-hand'],
  );
  assert.equal(calls[0]?.repoPath, '/repos/alpha', 'copied FROM the main checkout');
  assert.equal(report.length, 1);
  assert.equal(report[0]?.worktree, 'by-hand');
});

// The main checkout is not a worktree to heal — it is the SOURCE the copies come from.
test('the main checkout is never backfilled into itself', async () => {
  const { adopt, calls } = adopter();
  await adopt(scanned([]));
  assert.deepEqual(calls, []);
});

/*
 * The scan runs on every filesystem event a repo produces — a commit, a push, a branch
 * switch — so "heal on discovery" has to mean discovery, not every scan. Without this
 * the daemon would shell out `git check-ignore` per pattern per worktree, several times
 * a minute, forever.
 */
test('a worktree already seen is not backfilled again', async () => {
  const { adopt, calls } = adopter();
  const repos = scanned(['/repos/alpha/.worktrees/one']);
  await adopt(repos);
  await adopt(repos);
  await adopt(repos);
  assert.equal(calls.length, 1, 'healed once, not once per scan');
});

test('a worktree that appears later is picked up on the scan that reveals it', async () => {
  const { adopt, calls } = adopter();
  await adopt(scanned(['/repos/alpha/.worktrees/one']));
  await adopt(scanned(['/repos/alpha/.worktrees/one', '/repos/alpha/.worktrees/two']));
  assert.deepEqual(
    calls.map((c) => c.dest),
    ['/repos/alpha/.worktrees/one', '/repos/alpha/.worktrees/two'],
  );
});

// Silence would be indistinguishable from "nothing was wrong". A worktree that needed
// nothing is the common case and must NOT produce a line; one that was missing files
// is a thing the user should be told happened to their working copy.
test('only worktrees that were actually missing something are reported', async () => {
  const { adopt, calls } = adopter({ runConfigs: 0, files: 0 });
  const report = await adopt(scanned(['/repos/alpha/.worktrees/complete']));
  assert.equal(calls.length, 1, 'it still looked');
  assert.deepEqual(report, [], 'but there was nothing to say');
});

// A repo whose backfill throws (unreadable dir, races with a remove) must not cost the
// scan the rest of its worktrees — the scan is the topology, and it has to finish.
test('a backfill that throws is contained', async () => {
  let seen = 0;
  const adopt = createAdopter({
    cfg: {},
    backfill: async (_repoPath: string, dest: string) => {
      seen++;
      if (dest.endsWith('bad')) throw new Error('EACCES');
      return { runConfigs: 1, files: 0 };
    },
  });
  const report = await adopt(scanned(['/repos/alpha/.worktrees/bad', '/repos/alpha/.worktrees/good']));
  assert.equal(seen, 2, 'the second worktree was still attempted');
  assert.deepEqual(
    report.map((r) => r.worktree),
    ['good'],
  );
});
