/*
 * The folder picker's listing (server/browse.ts).
 *
 * A base directory is a path on the daemon's machine, and no browser API can produce one:
 * `webkitdirectory` uploads contents and returns relative names, `showDirectoryPicker()`
 * returns a handle with no path. So the daemon lists directories, and what it reports has
 * to be exactly enough to make the judgement — which folder CONTAINS repos — and nothing
 * more than that.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { browse } from '../server/browse.ts';

/** A tree: two repos, a plain folder, a hidden folder, node_modules and a loose file. */
function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-browse-'));
  for (const r of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(root, r, '.git'), { recursive: true });
  }
  fs.mkdirSync(path.join(root, 'notes'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'README.md'), '# x\n');
  return root;
}

test('lists directories only — never files', () => {
  const root = tree();
  const r = browse(root);
  assert.ok(!r.entries.some((e) => e.name === 'README.md'), 'a file must not be listed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('says which children are git repos, and how many', () => {
  /*
   * This is the whole judgement. `~/code` and `~/code/worktree-studio` look identical in a
   * text field, and one of them is a base directory while the other is a repo — the count
   * is what tells them apart before you save and find out.
   */
  const root = tree();
  const r = browse(root);
  assert.equal(r.repoCount, 2);
  assert.deepEqual(
    r.entries.filter((e) => e.repo).map((e) => e.name),
    ['alpha', 'beta'],
  );
  assert.equal(r.entries.find((e) => e.name === 'notes')?.repo, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('hides dotfiles and node_modules — never what anyone is navigating toward', () => {
  const root = tree();
  const names = browse(root).entries.map((e) => e.name);
  assert.deepEqual(names, ['alpha', 'beta', 'notes']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('sorts by name, so the list does not reorder itself between folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-browse-'));
  for (const n of ['zebra', 'apple', 'mango']) fs.mkdirSync(path.join(root, n));
  assert.deepEqual(
    browse(root).entries.map((e) => e.name),
    ['apple', 'mango', 'zebra'],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('offers a parent to go up to, and none at the filesystem root', () => {
  const root = tree();
  assert.equal(browse(root).parent, path.dirname(root));
  // `path.dirname('/')` is '/', which would draw an "up" button that goes nowhere.
  assert.equal(browse('/').parent, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('falls back to home with an error rather than going blank on a bad path', () => {
  /*
   * A picker that empties when you fat-finger a path is one you cannot get out of without
   * closing it. Saying where you ended up, and why, is the difference between a wrong
   * turn and a dead end.
   */
  const r = browse('/definitely/not/here');
  assert.equal(r.path, path.resolve(os.homedir()));
  assert.match(String(r.error), /cannot read/);
});

test('expands ~ , because that is how a path gets typed', () => {
  const r = browse('~');
  assert.equal(r.path, path.resolve(os.homedir()));
  assert.equal(r.error, undefined);
});

test('an empty path opens the home directory', () => {
  for (const input of ['', null, undefined, '   ']) {
    assert.equal(browse(input).path, path.resolve(os.homedir()), `input ${JSON.stringify(input)}`);
  }
});

test('a symlink to a file is not offered as a folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-browse-'));
  fs.writeFileSync(path.join(root, 'target.txt'), 'x');
  fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, 'link-to-file'));
  fs.mkdirSync(path.join(root, 'real-dir'));
  fs.symlinkSync(path.join(root, 'real-dir'), path.join(root, 'link-to-dir'));
  // A broken link resolves to nothing and must not appear either.
  fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'link-broken'));

  const names = browse(root).entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['link-to-dir', 'real-dir']);
  fs.rmSync(root, { recursive: true, force: true });
});
