// Preparing a repo's MAIN checkout for a new session.
//
// This is the one place Studio changes a checkout the user also works in by hand, so the
// tests here are mostly about what it REFUSES to do. Every refusal below corresponds to a
// way real work could otherwise be moved or lost.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  defaultBranchOf,
  describe,
  occupancy,
  prepareForSession,
  trackedModifications,
} from '../server/checkout.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd }).toString().trim();

/**
 * A local "origin" with a default branch, and a clone of it.
 *
 * A real remote, not a fake: `origin/HEAD`, fetch and `merge --ff-only` are exactly the
 * machinery under test, and a stub would test the stub.
 */
function repoPair(defaultBranch = 'develop') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-checkout-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');

  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', defaultBranch);
  git(seed, 'config', 'user.email', 't@t.t');
  git(seed, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(seed, 'README.md'), '# one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'one');

  execFileSync('git', ['clone', '-q', '--bare', seed, origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 't');
  // A fresh clone already has origin/HEAD; set it explicitly so the test does not depend
  // on the git version's clone behaviour.
  git(work, 'remote', 'set-head', 'origin', defaultBranch);

  /**
   * Add a commit to the remote, as a colleague pushing would.
   *
   * Pushes to the bare repo BY PATH: `seed` was the clone source, so it has no `origin`
   * of its own to push to.
   */
  const advanceRemote = (msg: string) => {
    fs.writeFileSync(path.join(seed, `${msg}.txt`), msg);
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', msg);
    git(seed, 'push', '-q', origin, defaultBranch);
  };

  return { root, work, advanceRemote, defaultBranch };
}

const head = (work: string) => git(work, 'rev-parse', '--abbrev-ref', 'HEAD');

test('defaultBranchOf reads origin/HEAD, not the branch you happen to be on', async () => {
  const { root, work } = repoPair('develop');
  git(work, 'checkout', '-qb', 'feature/x');
  assert.equal(await defaultBranchOf(work), 'develop');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a clean checkout on another branch is moved to the default branch', async () => {
  const { root, work } = repoPair('develop');
  git(work, 'checkout', '-qb', 'feature/x');

  const r = await prepareForSession(work);
  assert.equal(r.switched, true);
  assert.equal(r.branch, 'develop');
  assert.equal(head(work), 'develop');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the default branch is fast-forwarded to whatever the remote has now', async () => {
  const { root, work, advanceRemote } = repoPair('develop');
  advanceRemote('two');
  // The clone still points at the old tip until something fetches.
  assert.equal(git(work, 'log', '--oneline').split('\n').length, 1);

  const r = await prepareForSession(work);
  assert.equal(r.fetched, true);
  assert.equal(r.updated, true);
  assert.ok(git(work, 'log', '--oneline').includes('two'), 'the new commit is present');
  fs.rmSync(root, { recursive: true, force: true });
});

test('MODIFIED TRACKED FILES block the switch — they would be carried onto another branch', async () => {
  const { root, work } = repoPair('develop');
  git(work, 'checkout', '-qb', 'feature/x');
  fs.writeFileSync(path.join(work, 'README.md'), '# edited\n');

  const r = await prepareForSession(work);
  assert.equal(r.switched, false);
  assert.equal(head(work), 'feature/x', 'still where the user left it');
  assert.match(r.reason || '', /uncommitted change/);
  assert.equal(fs.readFileSync(path.join(work, 'README.md'), 'utf8'), '# edited\n', 'the edit is untouched');
  fs.rmSync(root, { recursive: true, force: true });
});

test('UNTRACKED files do NOT block the switch — checkout carries them across', async () => {
  /*
   * The case that motivated the distinction: a checkout whose only "changes" were six
   * untracked scratch files. Counting those as dirty would refuse every switch on a
   * working repo, and untracked files survive `git checkout` untouched anyway.
   */
  const { root, work } = repoPair('develop');
  git(work, 'checkout', '-qb', 'feature/x');
  fs.writeFileSync(path.join(work, 'scratch.md'), 'notes\n');

  const r = await prepareForSession(work);
  assert.equal(r.switched, true);
  assert.equal(head(work), 'develop');
  assert.ok(fs.existsSync(path.join(work, 'scratch.md')), 'the scratch file came across, not lost');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a DIVERGED default branch is reported, never reset', async () => {
  const { root, work, advanceRemote } = repoPair('develop');
  // Local and remote both move, from the same base — a genuine divergence.
  fs.writeFileSync(path.join(work, 'mine.txt'), 'mine');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'mine');
  advanceRemote('theirs');

  const r = await prepareForSession(work);
  assert.equal(r.updated, false);
  assert.match(r.reason || '', /diverged/);
  assert.ok(git(work, 'log', '--oneline').includes('mine'), 'the local commit still exists');
  fs.rmSync(root, { recursive: true, force: true });
});

test('switchBranch:false still fetches — a shared checkout must not be moved', async () => {
  // What a second unpromoted session in the same checkout gets: the refs are refreshed so
  // promote can branch from the latest, but the working copy is left where it is.
  const { root, work, advanceRemote } = repoPair('develop');
  git(work, 'checkout', '-qb', 'feature/x');
  advanceRemote('two');

  const r = await prepareForSession(work, { switchBranch: false });
  assert.equal(r.fetched, true);
  assert.equal(r.switched, false);
  assert.equal(head(work), 'feature/x');
  assert.ok(git(work, 'rev-parse', 'origin/develop'), 'the remote ref was still updated');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a repo with no origin/HEAD says so instead of guessing a branch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-noorigin-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'a');

  const r = await prepareForSession(root);
  assert.equal(r.switched, false);
  assert.match(r.reason || '', /no default branch/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('trackedModifications ignores untracked and reports staged', async () => {
  const { root, work } = repoPair('develop');
  fs.writeFileSync(path.join(work, 'untracked.txt'), 'x');
  assert.deepEqual(await trackedModifications(work), [], 'untracked is not a modification');

  fs.writeFileSync(path.join(work, 'README.md'), '# changed\n');
  git(work, 'add', 'README.md');
  // The PATH, not the porcelain line: this used to hand back ' M README.md' with the
  // status prefix still on it, which is why three callers each stripped it differently.
  assert.deepEqual(await trackedModifications(work), ['README.md'], 'staged counts, by path');
  fs.rmSync(root, { recursive: true, force: true });
});

/*
 * occupancy(): is this working copy already someone's?
 *
 * Deliberately a question about the FILESYSTEM rather than about Studio's records. A
 * Studio session holding the checkout is only one of the ways it can be busy — an agent
 * nobody launched through Studio leaves exactly the same evidence (tracked files
 * modified), and no registry of sessions can see that one.
 *
 * Being on a non-default branch is deliberately NOT evidence. It used to be, and it made
 * every clean checkout between tasks "occupied" — which fed `switchBranch: !occupied` and
 * cancelled the start-from-default behaviour prepareForSession() exists for.
 */
test('a clean checkout on the default branch is free', async () => {
  const { root, work } = repoPair('develop');
  assert.deepEqual(await occupancy(work), { occupied: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('a Studio session holding the checkout occupies it', async () => {
  const { root, work } = repoPair('develop');
  const occ = await occupancy(work, { held: true });
  assert.equal(occ.occupied, true);
  assert.equal(occ.occupied && occ.reason, 'session');
  fs.rmSync(root, { recursive: true, force: true });
});

// A branch left behind is the state every checkout is in between tasks. Calling it
// occupied stopped the switch back to the default branch, which is the one thing
// prepareForSession() is for — and `dirty` already covers the case where switching
// would actually cost something.
test('a clean checkout on another branch is free — the branch is not evidence', async () => {
  const { root, work } = repoPair('develop');
  git(work, 'checkout', '-qb', 'feature/someone-elses-work');
  assert.deepEqual(await occupancy(work), { occupied: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('modified tracked files occupy the checkout', async () => {
  const { root, work } = repoPair('develop');
  fs.writeFileSync(path.join(work, 'README.md'), '# someone is mid-edit\n');
  const occ = await occupancy(work);
  assert.equal(occ.occupied, true);
  assert.equal(occ.occupied && occ.reason, 'dirty');
  fs.rmSync(root, { recursive: true, force: true });
});

// The same carve-out prepareForSession() makes, for the same reason: `git checkout`
// carries untracked files across untouched, so they are not evidence anyone is working
// here. Counting them would exile every session to a worktree over six scratch scripts.
test('untracked files alone leave the checkout free', async () => {
  const { root, work } = repoPair('develop');
  fs.writeFileSync(path.join(work, 'scratch.sh'), 'echo hi\n');
  assert.deepEqual(await occupancy(work), { occupied: false });
  fs.rmSync(root, { recursive: true, force: true });
});

// A remote-less repo has no default branch to compare against and no reason to care:
// occupancy asks about work in progress, and this one has none.
test('a repo with no origin/HEAD is free when it is clean', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-occ-noorigin-'));
  git(root, 'init', '-q', '-b', 'whatever');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'a');
  assert.deepEqual(await occupancy(root), { occupied: false });
  fs.rmSync(root, { recursive: true, force: true });
});

// Precedence matters only because the reason is shown to the user: "another session is
// working here" explains the worktree better than "1 uncommitted change" does.
test('a held checkout reports the session, not whatever else is also true of it', async () => {
  const { root, work } = repoPair('develop');
  fs.writeFileSync(path.join(work, 'README.md'), '# dirty too\n');
  const occ = await occupancy(work, { held: true });
  assert.equal(occ.occupied && occ.reason, 'session');
  fs.rmSync(root, { recursive: true, force: true });
});

test('describe() is silent when nothing surprising happened', () => {
  assert.equal(
    describe({ branch: 'develop', defaultBranch: 'develop', fetched: true, switched: false, updated: false }),
    '',
  );
  assert.match(
    describe({ branch: 'develop', defaultBranch: 'develop', fetched: true, switched: true, updated: true }),
    /on develop, updated/,
  );
  assert.equal(
    describe({
      branch: 'x',
      defaultBranch: 'develop',
      fetched: true,
      switched: false,
      updated: false,
      reason: 'left on x',
    }),
    'left on x',
  );
});
