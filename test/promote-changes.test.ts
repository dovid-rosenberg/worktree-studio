import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../server/util.ts';

/*
 * Moving uncommitted work out of the main checkout and into a freshly promoted worktree.
 *
 * The whole trick rests on one property of git that is easy to assume and worth pinning:
 * the stash stack lives in the REPOSITORY (refs/stash), not in a working tree. So a
 * stash pushed from the main checkout is visible to `git stash pop` run inside a
 * worktree of the same repo. If that were per-worktree, the pop would find nothing and
 * the changes would silently stay behind — the exact failure this feature exists to fix.
 *
 * These tests drive real git rather than a mock, because the thing under test IS the git
 * behaviour. They are cheap: a repo with two commits and a couple of files.
 */

/** A throwaway repo with one commit on `main`, plus a worktree branched off it. */
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'wts-promote-'));
  const g = (...args: string[]) => run('git', ['-C', dir, ...args]);
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 't@t.test');
  await g('config', 'user.name', 'T');
  await writeFile(join(dir, 'kept.txt'), 'base\n');
  // Real repos ignore the nested worktree container; worktree.create() warns when they
  // do not. Without this the container itself counts as uncommitted work.
  await writeFile(join(dir, '.gitignore'), '.worktrees/\n');
  await g('add', '-A');
  await g('commit', '-qm', 'base');
  return { dir, g, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** The helper under test, lifted out of SessionManager so the test needs no daemon. */
async function moveDirtyInto(repoPath: string, worktreePath: string) {
  const st = await run('git', ['-C', repoPath, 'status', '--porcelain']);
  const before = st.stdout.split('\n').filter(Boolean);
  if (!before.length) return { ok: true as const, moved: 0 };
  const container = worktreePath.split('/').slice(-2)[0];
  if (before.some((l) => l.slice(3).replace(/^"|"$/g, '').startsWith(`${container}/`))) {
    return { ok: false as const, error: `refusing to move changes: "${container}/" is not gitignored` };
  }
  const label = 'wt-studio: promote test';
  const push = await run('git', ['-C', repoPath, 'stash', 'push', '--include-untracked', '-m', label]);
  if (push.code !== 0) return { ok: false as const, error: push.stderr.trim() };
  const pop = await run('git', ['-C', worktreePath, 'stash', 'pop']);
  if (pop.code !== 0) return { ok: false as const, error: pop.stderr.trim(), stashed: label };
  return { ok: true as const, moved: before.length };
}

test('a modified file moves into the worktree and leaves main clean', async (t) => {
  const { dir, g, cleanup } = await repo();
  t.after(cleanup);
  const wt = join(dir, '.worktrees', 'feat');
  await g('worktree', 'add', '-q', '-b', 'feature/x', wt, 'main');

  await writeFile(join(dir, 'kept.txt'), 'edited in main\n');
  const r = await moveDirtyInto(dir, wt);

  assert.equal(r.ok, true);
  assert.equal(r.moved, 1);
  assert.equal(await readFile(join(wt, 'kept.txt'), 'utf8'), 'edited in main\n',
    'the edit is in the worktree');
  assert.equal(await readFile(join(dir, 'kept.txt'), 'utf8'), 'base\n',
    'main is back to its committed state');
});

test('an untracked file comes along too — half a change is worse than none', async (t) => {
  const { dir, g, cleanup } = await repo();
  t.after(cleanup);
  const wt = join(dir, '.worktrees', 'feat');
  await g('worktree', 'add', '-q', '-b', 'feature/x', wt, 'main');

  // The commonest promote scenario: you started a NEW file, then realised it is real work.
  await writeFile(join(dir, 'brand-new.ts'), 'export const x = 1;\n');
  await writeFile(join(dir, 'kept.txt'), 'also edited\n');
  const r = await moveDirtyInto(dir, wt);

  assert.equal(r.ok, true);
  assert.ok(existsSync(join(wt, 'brand-new.ts')), 'the untracked file moved');
  assert.ok(!existsSync(join(dir, 'brand-new.ts')), 'and is gone from main');
  assert.equal(await readFile(join(wt, 'kept.txt'), 'utf8'), 'also edited\n');
});

test('a nested untracked directory survives the move', async (t) => {
  const { dir, g, cleanup } = await repo();
  t.after(cleanup);
  const wt = join(dir, '.worktrees', 'feat');
  await g('worktree', 'add', '-q', '-b', 'feature/x', wt, 'main');

  await mkdir(join(dir, 'src', 'deep'), { recursive: true });
  await writeFile(join(dir, 'src', 'deep', 'mod.ts'), 'export {};\n');
  const r = await moveDirtyInto(dir, wt);

  assert.equal(r.ok, true);
  assert.ok(existsSync(join(wt, 'src', 'deep', 'mod.ts')));
});

test('on conflict the work is left in the stash, never dropped', async (t) => {
  const { dir, g, cleanup } = await repo();
  t.after(cleanup);
  const wt = join(dir, '.worktrees', 'feat');
  await g('worktree', 'add', '-q', '-b', 'feature/x', wt, 'main');

  // Make the pop conflict: the worktree already changed the same line, committed, so
  // replaying main's edit on top cannot apply cleanly.
  await writeFile(join(wt, 'kept.txt'), 'worktree version\n');
  await run('git', ['-C', wt, 'commit', '-qam', 'diverge']);
  await writeFile(join(dir, 'kept.txt'), 'main version\n');

  const r = await moveDirtyInto(dir, wt);

  assert.equal(r.ok, false, 'the caller must hear about it');
  // The point of the whole design: a failed replay is recoverable, not a loss.
  const list = await run('git', ['-C', dir, 'stash', 'list']);
  assert.match(list.stdout, /wt-studio: promote test/,
    'the stash entry is still there to pop by hand');
});

test('a clean main is a no-op rather than an empty stash', async (t) => {
  const { dir, g, cleanup } = await repo();
  t.after(cleanup);
  const wt = join(dir, '.worktrees', 'feat');
  await g('worktree', 'add', '-q', '-b', 'feature/x', wt, 'main');

  const r = await moveDirtyInto(dir, wt);
  assert.deepEqual(r, { ok: true, moved: 0 });
  const list = await run('git', ['-C', dir, 'stash', 'list']);
  assert.equal(list.stdout.trim(), '', 'no stash entry was created');
});

test('refuses to move when the worktree container is not gitignored', async (t) => {
  // The destructive case worth a hard stop: without the ignore, `.worktrees/` is itself
  // "uncommitted work", and --include-untracked would stash every checkout under it —
  // removing them from disk. Better to send the user to their .gitignore.
  const { dir, g, cleanup } = await repo();
  t.after(cleanup);
  await rm(join(dir, '.gitignore'));
  await g('commit', '-qam', 'drop the ignore');
  const wt = join(dir, '.worktrees', 'feat');
  await g('worktree', 'add', '-q', '-b', 'feature/x', wt, 'main');
  await writeFile(join(dir, 'kept.txt'), 'edited\n');

  const r = await moveDirtyInto(dir, wt);

  assert.equal(r.ok, false);
  assert.match(String(r.error), /not gitignored/);
  const list = await run('git', ['-C', dir, 'stash', 'list']);
  assert.equal(list.stdout.trim(), '', 'nothing was stashed — the worktree is untouched');
  assert.ok(existsSync(join(wt, 'kept.txt')), 'and the other checkout is still on disk');
});
