// One parser for `git status --porcelain`, and the data-loss guard that depends on it.
//
// The parse was written three times with three different contracts — one stripped the
// `XY ` status prefix, one left it on, and one stripped an already-stripped line a second
// time. The last of those was the guard below, which is why the first test here is not
// about parsing at all: it is about a refusal that could never happen.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { parsePorcelain, porcelainStatus } from '../server/git.ts';
import { SessionManager } from '../server/sessions.ts';
import type { PartialDeep, Config } from '../server/types.ts';
import { muxStub } from './helpers.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** A repo with one commit, and no identity borrowed from the machine running the suite. */
function tempRepo(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wts-${name}-`));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

function manager(): SessionManager {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-state-'));
  const cfg: PartialDeep<Config> = {
    _stateDir: stateDir,
    _file: path.join(stateDir, 'config.json'),
    web: { port: 0 },
    claude: { cmd: 'claude' },
    baseDirs: [],
    copyPatterns: {},
  };
  return new SessionManager(cfg, muxStub());
}

/*
 * The refusal this whole track exists for.
 *
 * A `nested` layout puts worktrees inside the repo. When that directory is not
 * gitignored, git reports it as untracked work, and `stash push --include-untracked`
 * would move every sibling worktree into the stash and delete it from disk. The guard
 * that refuses this compared a status prefix that `_dirtyMain` had already removed, so
 * `.worktrees/` was tested as `rktrees/` and the refusal never fired — the promote went
 * ahead and took the checkouts with it.
 */
test('_moveDirtyInto refuses when the worktree container is not gitignored', async () => {
  const repo = tempRepo('porcelain-guard');
  // Deliberately NO .gitignore entry for .worktrees/ — that is the hazard.
  const wt = path.join(repo, '.worktrees', 'foo');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, 'work-in-progress.txt'), 'hours of it\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# edited\n');

  const dirty = await manager()._dirtyMain(repo);
  assert.ok(
    dirty.some((p) => p.startsWith('.worktrees')),
    `the sibling worktree must show up as dirty work, or the guard has nothing to see: ${JSON.stringify(dirty)}`,
  );

  const r = await manager()._moveDirtyInto(repo, wt);
  assert.equal(r.ok, false, 'stashing a sibling worktree would delete it from disk; this must refuse');
  assert.match(r.error || '', /not gitignored/, 'the refusal has to say what to add to .gitignore');
  assert.ok(
    fs.existsSync(path.join(wt, 'work-in-progress.txt')),
    'the refusal must leave the sibling worktree exactly where it was',
  );
  assert.equal(git(repo, 'stash', 'list'), '', 'nothing may be stashed once the guard has refused');
  fs.rmSync(repo, { recursive: true, force: true });
});

/*
 * The parser, against strings git actually emits.
 *
 * Kept table-driven and pure so each shape is one line: what git printed, and what the
 * three consumers are entitled to read out of it.
 */
const CASES: { name: string; line: string; want: { status: string; path: string; from?: string } }[] = [
  { name: 'unstaged modification', line: ' M src/a.ts', want: { status: ' M', path: 'src/a.ts' } },
  { name: 'staged modification', line: 'M  src/a.ts', want: { status: 'M ', path: 'src/a.ts' } },
  { name: 'staged addition', line: 'A  src/new.ts', want: { status: 'A ', path: 'src/new.ts' } },
  { name: 'untracked file', line: '?? scratch.txt', want: { status: '??', path: 'scratch.txt' } },
  {
    name: 'untracked directory, which git collapses to the directory itself',
    line: '?? .worktrees/',
    want: { status: '??', path: '.worktrees/' },
  },
  {
    // A space forces git to quote, which is exactly what the old callers stripped with a
    // regex that only removed the outer quotes and left the escapes in place.
    name: 'a path with a space',
    line: '?? "new file.txt"',
    want: { status: '??', path: 'new file.txt' },
  },
  {
    // Octal escapes of the UTF-8 bytes, per the default core.quotePath.
    name: 'a non-ASCII path',
    line: ' M "\\303\\274ni.txt"',
    want: { status: ' M', path: 'üni.txt' },
  },
  {
    name: 'a rename, whose destination is the path that now exists',
    line: 'R  a.txt -> "renamed a.txt"',
    want: { status: 'R ', path: 'renamed a.txt', from: 'a.txt' },
  },
  {
    name: 'a copy, which carries a source just as a rename does',
    line: 'C  a.txt -> b.txt',
    want: { status: 'C ', path: 'b.txt', from: 'a.txt' },
  },
  {
    // Not a rename: an untracked file whose NAME contains the separator. Reading the
    // quoted field to its closing quote first is what keeps these apart.
    name: 'a file literally named with an arrow',
    line: '?? "a -> b.txt"',
    want: { status: '??', path: 'a -> b.txt' },
  },
];

for (const c of CASES) {
  test(`parsePorcelain: ${c.name}`, () => {
    assert.deepEqual(parsePorcelain(c.line), [c.want], `parsing ${JSON.stringify(c.line)}`);
  });
}

test('parsePorcelain: a clean repo says nothing at all', () => {
  assert.deepEqual(parsePorcelain(''), [], 'empty output is zero entries, not one blank one');
  assert.deepEqual(parsePorcelain('\n'), [], 'a trailing newline is not an entry');
});

test('parsePorcelain reads a whole status, in order', () => {
  const entries = parsePorcelain(['M  a.txt', ' D b.txt', '?? "c d.txt"'].join('\n'));
  assert.deepEqual(
    entries.map((e) => `${e.status}|${e.path}`),
    ['M |a.txt', ' D|b.txt', '??|c d.txt'],
    'every line is one entry and the order is preserved',
  );
});

/*
 * Against real git, because the escaping rules above are a claim about git's output and
 * a table of hand-written strings cannot check that claim.
 */
test('porcelainStatus reads real git output, quoting and all', async () => {
  const repo = tempRepo('porcelain-live');
  fs.writeFileSync(path.join(repo, 'a b.txt'), 'spaces\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
  git(repo, 'add', 'a b.txt');
  git(repo, 'commit', '-qm', 'spaces');
  fs.writeFileSync(path.join(repo, 'a b.txt'), 'spaces, edited\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'x\n');

  const all = await porcelainStatus(repo);
  assert.deepEqual(
    all.map((e) => e.path).sort(),
    ['README.md', 'a b.txt', 'untracked.txt'],
    'a quoted path comes back as the name on disk, and untracked files are included',
  );

  const tracked = await porcelainStatus(repo, { untracked: false });
  assert.deepEqual(
    tracked.map((e) => e.path).sort(),
    ['README.md', 'a b.txt'],
    'untracked: false asks git a different question rather than filtering the answer',
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

test('porcelainStatus on a directory that is not a repo is empty, not a throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-norepo-'));
  assert.deepEqual(await porcelainStatus(dir), [], 'a failed git call is no changes, not a crash');
  fs.rmSync(dir, { recursive: true, force: true });
});
