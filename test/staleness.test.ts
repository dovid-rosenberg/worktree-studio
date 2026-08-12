/*
 * depsStale — the dependency failure that looks like a code bug.
 *
 * depsMissing() answers a binary question: package.json, no node_modules. The worktree
 * that costs an afternoon is the other one. It was installed three weeks ago, has since
 * been rebased onto a branch that bumped a dependency, and every signal is green — deps
 * resolve, the dev server starts, depsMissing is correctly false. What comes out is a
 * TypeError from inside a package nobody touched, or a 404 on a route the installed
 * router version predates. That reads as a bug in the branch you are reading, which is
 * exactly where the hours go.
 *
 * npm rewrites `node_modules/.package-lock.json` on every install, so "the tree is older
 * than the lockfile that describes it" is one mtime comparison. These pin the three
 * silences as hard as the signal: a false alarm on this would be worse than no signal,
 * because the mark would be on every card and would mean nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Servers } from '../server/servers.ts';
import { skipReason } from '../server/start-report.ts';

function servers(extra = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-stale-'));
  const cfg = { _stateDir: stateDir, web: { port: 0 }, start: { api: { cmd: ':', ports: [] } }, ...extra };
  return new Servers(cfg);
}

/**
 * A worktree with a lockfile and (optionally) an installed tree, with the two mtimes set
 * explicitly.
 *
 * Stamped rather than written in sequence: a test that relies on two consecutive writes
 * landing in different milliseconds is a test that fails on a fast machine, and HFS+
 * reports whole seconds for some writes anyway.
 */
function locked({ lock, installed }: { lock: number; installed?: number }): string {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-lockwt-'));
  const lockFile = path.join(wt, 'package-lock.json');
  fs.writeFileSync(lockFile, '{"lockfileVersion":3}');
  fs.utimesSync(lockFile, new Date(lock), new Date(lock));
  if (installed !== undefined) {
    fs.mkdirSync(path.join(wt, 'node_modules'));
    const stamp = path.join(wt, 'node_modules', '.package-lock.json');
    fs.writeFileSync(stamp, '{"lockfileVersion":3}');
    fs.utimesSync(stamp, new Date(installed), new Date(installed));
  }
  return wt;
}

const T0 = 1_700_000_000_000;

test('a tree installed before the lockfile changed is stale', () => {
  const s = servers();
  const wt = locked({ lock: T0 + 60_000, installed: T0 });
  assert.equal(s.depsStale(wt), true, 'the lockfile moved after the last install');
  fs.rmSync(wt, { recursive: true, force: true });
});

test('a tree installed after the lockfile is not stale', () => {
  const s = servers();
  const wt = locked({ lock: T0, installed: T0 + 60_000 });
  assert.equal(s.depsStale(wt), false);
  fs.rmSync(wt, { recursive: true, force: true });
});

/*
 * An install that finished in the same millisecond the lock was written is a FRESH
 * install — npm writes both. Strictly-newer, not newer-or-equal, or every worktree
 * installed by `npm install` on a coarse-timestamp filesystem would read as stale.
 */
test('equal mtimes are a fresh install, not a stale one', () => {
  const s = servers();
  const wt = locked({ lock: T0, installed: T0 });
  assert.equal(s.depsStale(wt), false);
  fs.rmSync(wt, { recursive: true, force: true });
});

test('no package-lock.json — nothing to be stale against', () => {
  const s = servers();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-nolock-'));
  fs.mkdirSync(path.join(wt, 'node_modules'));
  fs.writeFileSync(path.join(wt, 'node_modules', '.package-lock.json'), '{}');
  assert.equal(s.depsStale(wt), false, 'no lockfile is not evidence of anything');
  fs.rmSync(wt, { recursive: true, force: true });
});

/*
 * A lockfile with no npm bookkeeping beside it is one of two things, and neither is this
 * signal's story: nothing is installed (depsMissing already says so, with a button), or
 * the tree was written by yarn/pnpm/bun, which do not write `.package-lock.json` at all.
 * Claiming staleness from a file another tool never writes would mark every such
 * worktree stale forever — a permanent warning nobody can clear, which is the failure
 * mode that makes a signal worthless.
 */
test('a tree npm did not write is not judged', () => {
  const s = servers();
  const wt = locked({ lock: T0 });
  fs.mkdirSync(path.join(wt, 'node_modules')); // installed by something else
  assert.equal(s.depsStale(wt), false);
  fs.rmSync(wt, { recursive: true, force: true });
});

test('a directory with nothing in it makes no claim', () => {
  const s = servers();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-bare-'));
  assert.equal(s.depsStale(wt), false);
  fs.rmSync(wt, { recursive: true, force: true });
});

/*
 * STALE DEPS MUST NOT BLOCK A START, and this is the whole design of the feature.
 *
 * A stale tree usually runs — that is precisely why the failure it produces is confusing.
 * Refusing to launch would trade a confusing failure for an impossible one, and the
 * install is one click away on the same card.
 */
test('stale deps ride on the decoration and leave canStart alone', () => {
  const s = servers({ start: { api: { cmd: 'npm run dev' } } });
  const wt = locked({ lock: T0 + 60_000, installed: T0 });
  fs.writeFileSync(path.join(wt, 'package.json'), '{"name":"api","dependencies":{"express":"^4"}}');
  const dec = s.decorate({ path: wt, repo: 'api' }, new Map());
  assert.equal(dec.depsStale, true, 'the rail can see it');
  assert.equal(dec.depsMissing, false, 'the tree IS installed — that is the trap');
  assert.equal(dec.canStart, true, 'and it still starts, because it does');
  fs.rmSync(wt, { recursive: true, force: true });
});

test('a vanished worktree has no files to compare', () => {
  const s = servers({ start: { api: { cmd: 'npm run dev' } } });
  const wt = locked({ lock: T0 + 60_000, installed: T0 });
  fs.rmSync(wt, { recursive: true, force: true });
  const dec = s.decorate({ path: wt, repo: 'api' }, new Map());
  assert.equal(dec.gone, true);
  assert.equal(dec.depsStale, false, '`gone` is the only thing worth saying about it');
});

/*
 * The decorate path runs on every topology build, once per worktree, so the two statSync
 * this adds have to be cheap enough not to matter — and be shown to be, rather than
 * asserted in a comment.
 */
test('the staleness check costs two stats, not a read', () => {
  const s = servers();
  const wt = locked({ lock: T0 + 60_000, installed: T0 });
  for (let i = 0; i < 200; i++) s.depsStale(wt); // warm the dentry cache
  const started = process.hrtime.bigint();
  const n = 2000;
  for (let i = 0; i < n; i++) s.depsStale(wt);
  const us = Number(process.hrtime.bigint() - started) / 1000 / n;
  assert.ok(us < 100, `${us.toFixed(1)}µs per worktree — this is meant to be two stats`);
  fs.rmSync(wt, { recursive: true, force: true });
});

/*
 * skipReason can NAME it — last, and only in place of "cannot start".
 *
 * Stale deps never make canStart false, so this line is only ever reached by a member
 * that is unstartable for a reason none of the three known causes explains. In that
 * position the alternative is a sentence that names nothing and offers nothing to press.
 */
test('skipReason names stale deps only when nothing better explains the skip', () => {
  assert.equal(
    skipReason({ repo: 'api', path: '/w', depsStale: true }),
    'dependencies may be stale — the lockfile is newer than the installed tree',
  );
  assert.equal(
    skipReason({ repo: 'api', path: '/w', depsStale: true, depsMissing: true }),
    'dependencies not installed',
    'a real blocker outranks a warning',
  );
  assert.equal(
    skipReason({ repo: 'api', path: '/w', depsStale: true, noStartCmd: true }),
    'no start command configured for this repo',
  );
  assert.equal(
    skipReason({ repo: 'api', path: '/w', depsStale: true, gone: true }),
    'the worktree directory no longer exists',
  );
});
