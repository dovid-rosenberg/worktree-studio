// Hunk staging against real repos (server/hunks.ts). The pure model is covered in
// test/diff.test.js; what matters here is that git accepts what we generate — so the
// assertions are mostly "what does `git diff --cached` say afterwards", plus a
// round-trip check (parse git's own diff → re-serialize → `git apply --check`) run over
// every awkward file shape.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import * as hunks from '../server/hunks.ts';
import { parsePatch, formatFilePatch } from '../server/diff.ts';

function sh(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }

// A repo with one commit. core.autocrlf=false so the CRLF case is about the diff model,
// not about git's line-ending conversion.
function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-hunks-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 't@t.t']);
  sh(dir, ['config', 'user.name', 't']);
  sh(dir, ['config', 'core.autocrlf', 'false']);
  for (const [name, content] of Object.entries(files)) write(dir, name, content);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-qm', 'base']);
  return dir;
}
function write(dir, name, content) { fs.writeFileSync(path.join(dir, name), content); }
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
const numbered = (n, prefix = 'L') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const cached = (dir) => sh(dir, ['diff', '--cached']);
const unstaged = (dir) => sh(dir, ['diff']);
const atAt = (text) => text.split('\n').filter((l) => l.startsWith('@@'));

// The strongest check we have: hand git back a patch we built from its own diff and see
// whether it would apply it to the index.
function applies(dir, patch, extra = []) {
  const r = spawnSync('git', ['-C', dir, 'apply', '--cached', '--check', ...extra, '-'], { input: patch, encoding: 'utf8' });
  return { ok: r.status === 0, err: (r.stderr || '').trim() };
}

// A 40-line file changed in three places → three hunks, far enough apart not to merge.
function threeHunkRepo() {
  const dir = repo({ 'p.txt': `${numbered(40, 'p').join('\n')}\n` });
  const lines = numbered(40, 'p');
  lines[2] = 'p3 CHANGED';
  lines[19] = 'p20 CHANGED';
  lines[35] = 'p36 CHANGED';
  write(dir, 'p.txt', `${lines.join('\n')}\n`);
  return dir;
}

// ---------------------------------------------------------------------------
// The core promise: one hunk moves, the others do not
// ---------------------------------------------------------------------------

test('stage() puts exactly the chosen hunk in the index', async () => {
  const dir = threeHunkRepo();
  const out = await hunks.stage(dir, { file: 'p.txt', hunks: [1] });
  assert.equal(out.ok, true, out.error);
  const staged = cached(dir);
  assert.match(staged, /^\+p20 CHANGED$/m);
  assert.doesNotMatch(staged, /p3 CHANGED/);
  assert.doesNotMatch(staged, /p36 CHANGED/);
  assert.deepEqual(atAt(staged).length, 1, 'exactly one hunk staged');
  rm(dir);
});

test('stage() leaves the other hunks unstaged', async () => {
  const dir = threeHunkRepo();
  await hunks.stage(dir, { file: 'p.txt', hunks: [1] });
  const rest = unstaged(dir);
  assert.match(rest, /^\+p3 CHANGED$/m);
  assert.match(rest, /^\+p36 CHANGED$/m);
  assert.doesNotMatch(rest, /p20 CHANGED/);
  rm(dir);
});

test('stage() never touches the working tree', async () => {
  const dir = threeHunkRepo();
  const before = fs.readFileSync(path.join(dir, 'p.txt'), 'utf8');
  await hunks.stage(dir, { file: 'p.txt', hunks: [0] });
  assert.equal(fs.readFileSync(path.join(dir, 'p.txt'), 'utf8'), before);
  rm(dir);
});

test('unstage() takes one hunk back out of the index and leaves the rest staged', async () => {
  const dir = threeHunkRepo();
  sh(dir, ['add', 'p.txt']); // file-level stage: all three hunks
  const before = await hunks.fileHunks(dir, 'p.txt');
  assert.equal(before.staged.hunks.length, 3);
  const out = await hunks.unstage(dir, { file: 'p.txt', hunks: [1] });
  assert.equal(out.ok, true, out.error);
  const staged = cached(dir);
  assert.doesNotMatch(staged, /p20 CHANGED/, 'the unstaged hunk is gone from the index');
  assert.match(staged, /^\+p3 CHANGED$/m);
  assert.match(staged, /^\+p36 CHANGED$/m);
  assert.match(unstaged(dir), /^\+p20 CHANGED$/m, 'and is back on the unstaged side');
  rm(dir);
});

test('stage() then unstage() of the same hunk leaves an empty index diff', async () => {
  const dir = threeHunkRepo();
  await hunks.stage(dir, { file: 'p.txt', hunks: [2] });
  const out = await hunks.unstage(dir, { file: 'p.txt', hunks: [0] });
  assert.equal(out.ok, true, out.error);
  assert.equal(cached(dir), '');
  rm(dir);
});

// ---------------------------------------------------------------------------
// Recomputed @@ offsets — hunks whose line counts differ
// ---------------------------------------------------------------------------

// hunk 0 inserts 4 lines (+4), hunk 1 deletes 2 (−2), hunk 2 is a 1-for-1 edit (0).
// Any subset of these needs the surviving hunks' new-side offsets rewritten.
function unbalancedRepo() {
  const dir = repo({ 'o.txt': `${numbered(60, 'b').join('\n')}\n` });
  const lines = numbered(60, 'b');
  lines[49] = 'b50 CHANGED';
  lines.splice(24, 2);
  lines.splice(3, 0, 'ins1', 'ins2', 'ins3', 'ins4');
  write(dir, 'o.txt', `${lines.join('\n')}\n`);
  return dir;
}

test('stage() of a late hunk rewrites its @@ offset for the hunks it left behind', async () => {
  const dir = unbalancedRepo();
  const before = await hunks.fileHunks(dir, 'o.txt');
  assert.deepEqual(before.unstaged.hunks.map((h) => h.header),
    ['@@ -1,6 +1,10 @@', '@@ -22,8 +26,6 @@ b21', '@@ -47,7 +49,7 @@ b46']);
  const out = await hunks.stage(dir, { file: 'o.txt', hunks: [2] });
  assert.equal(out.ok, true, out.error);
  // Full patch says +49; with the +4 and −2 hunks skipped it has to be +47.
  assert.deepEqual(atAt(cached(dir)), ['@@ -47,7 +47,7 @@ b46']);
  rm(dir);
});

test('unstage() of a late hunk rewrites the other side’s offset the same way', async () => {
  const dir = unbalancedRepo();
  sh(dir, ['add', 'o.txt']);
  const out = await hunks.unstage(dir, { file: 'o.txt', hunks: [2] });
  assert.equal(out.ok, true, out.error);
  assert.match(unstaged(dir), /^\+b50 CHANGED$/m);
  assert.equal(atAt(cached(dir)).length, 2, 'the +4 and −2 hunks stay staged');
  rm(dir);
});

test('staging every hunk one at a time ends up identical to staging the whole file', async () => {
  const dir = unbalancedRepo();
  const expected = (() => { const d = unbalancedRepo(); sh(d, ['add', 'o.txt']); const t = sh(d, ['rev-parse', ':o.txt']); rm(d); return t; })();
  for (let i = 0; i < 3; i++) {
    const out = await hunks.stage(dir, { file: 'o.txt', hunks: [0] }); // always the first remaining
    assert.equal(out.ok, true, out.error);
  }
  assert.equal(sh(dir, ['rev-parse', ':o.txt']), expected, 'index blob matches a plain `git add`');
  assert.equal(unstaged(dir), '', 'nothing left unstaged');
  rm(dir);
});

// ---------------------------------------------------------------------------
// A file that is already partially staged
// ---------------------------------------------------------------------------

test('hunks are read against the INDEX, so an already-staged hunk drops out of the unstaged list', async () => {
  const dir = threeHunkRepo();
  await hunks.stage(dir, { file: 'p.txt', hunks: [0] });
  const after = await hunks.fileHunks(dir, 'p.txt');
  assert.equal(after.unstaged.hunks.length, 2, 'the staged hunk is no longer offered for staging');
  assert.equal(after.staged.hunks.length, 1, 'and shows up as unstageable instead');
  rm(dir);
});

test('a second stage() on a partially staged file still applies cleanly', async () => {
  const dir = threeHunkRepo();
  await hunks.stage(dir, { file: 'p.txt', hunks: [0] });
  const out = await hunks.stage(dir, { file: 'p.txt', hunks: [1] }); // index 1 of what REMAINS
  assert.equal(out.ok, true, out.error);
  const staged = cached(dir);
  assert.match(staged, /^\+p3 CHANGED$/m);
  assert.match(staged, /^\+p36 CHANGED$/m);
  assert.doesNotMatch(staged, /p20 CHANGED/);
  rm(dir);
});

test('a file staged and then edited again offers both sides independently', async () => {
  const dir = repo({ 'w.txt': `${numbered(10).join('\n')}\n` });
  const v1 = numbered(10); v1[0] = 'L1 staged';
  write(dir, 'w.txt', `${v1.join('\n')}\n`);
  sh(dir, ['add', 'w.txt']);
  const v2 = [...v1]; v2[9] = 'L10 unstaged';
  write(dir, 'w.txt', `${v2.join('\n')}\n`);
  const fh = await hunks.fileHunks(dir, 'w.txt');
  assert.equal(fh.staged.hunks.length, 1);
  assert.equal(fh.unstaged.hunks.length, 1);
  assert.match(fh.staged.hunks[0].lines.map((l) => l.text).join('\n'), /L1 staged/);
  assert.match(fh.unstaged.hunks[0].lines.map((l) => l.text).join('\n'), /L10 unstaged/);
  rm(dir);
});

// ---------------------------------------------------------------------------
// Awkward file shapes
// ---------------------------------------------------------------------------

test('a file with no trailing newline stages with its "\\ No newline" markers intact', async () => {
  const dir = repo({ 'n.txt': 'a\nb\nc' }); // deliberately unterminated
  write(dir, 'n.txt', 'a\nB\nC');
  const out = await hunks.stage(dir, { file: 'n.txt', hunks: [0] });
  assert.equal(out.ok, true, out.error);
  assert.equal(sh(dir, ['show', ':n.txt']), 'a\nB\nC', 'index blob is still unterminated');
  assert.equal(unstaged(dir), '');
  rm(dir);
});

test('staging an EARLY hunk of an unterminated file leaves the "\\ No newline" hunk behind', async () => {
  const dir = repo({ 'n.txt': numbered(20).join('\n') }); // no trailing newline
  const lines = numbered(20);
  lines[1] = 'L2 CHANGED';
  lines[19] = 'L20 CHANGED';
  write(dir, 'n.txt', lines.join('\n'));
  const out = await hunks.stage(dir, { file: 'n.txt', hunks: [0] });
  assert.equal(out.ok, true, out.error);
  assert.doesNotMatch(cached(dir), /No newline/, 'the marker belongs to the hunk we skipped');
  assert.match(unstaged(dir), /\\ No newline at end of file/);
  assert.equal(sh(dir, ['show', ':n.txt']), lines.slice(0, 19).concat('L20').join('\n'));
  rm(dir);
});

test('a CRLF file keeps its line endings byte for byte through staging', async () => {
  const dir = repo({ 'c.txt': 'x\r\ny\r\nz\r\n' });
  write(dir, 'c.txt', 'x\r\nY\r\nz\r\n');
  const fh = await hunks.fileHunks(dir, 'c.txt');
  assert.deepEqual(fh.unstaged.hunks[0].lines.map((l) => l.text), ['x\r', 'y\r', 'Y\r', 'z\r']);
  const out = await hunks.stage(dir, { file: 'c.txt', hunks: [0] });
  assert.equal(out.ok, true, out.error);
  assert.equal(sh(dir, ['show', ':c.txt']), 'x\r\nY\r\nz\r\n');
  rm(dir);
});

test('an untracked file is offered as an added file and can be staged by hunk', async () => {
  const dir = repo({ 'keep.txt': 'keep\n' });
  write(dir, 'new.txt', 'n1\nn2\nn3\n');
  const fh = await hunks.fileHunks(dir, 'new.txt');
  assert.equal(fh.untracked, true);
  assert.equal(fh.unstaged.status, 'added');
  assert.equal(fh.unstaged.hunks.length, 1);
  const out = await hunks.stage(dir, { file: 'new.txt', hunks: [0] });
  assert.equal(out.ok, true, out.error);
  assert.equal(sh(dir, ['status', '--porcelain', '--', 'new.txt']), 'A  new.txt\n');
  rm(dir);
});

test('a deleted file stages as a deletion', async () => {
  const dir = repo({ 'del.txt': 'd1\nd2\n' });
  fs.rmSync(path.join(dir, 'del.txt'));
  const fh = await hunks.fileHunks(dir, 'del.txt');
  assert.equal(fh.unstaged.status, 'deleted');
  const out = await hunks.stage(dir, { file: 'del.txt', hunks: [0] });
  assert.equal(out.ok, true, out.error);
  assert.equal(sh(dir, ['status', '--porcelain', '--', 'del.txt']), 'D  del.txt\n');
  rm(dir);
});

test('staging a hunk of a renamed file leaves the staged rename intact', async () => {
  const dir = repo({ 'r.txt': `${numbered(20, 'r').join('\n')}\n` });
  sh(dir, ['mv', 'r.txt', 'r2.txt']); // git mv already put the rename in the index
  const lines = numbered(20, 'r');
  lines[1] = 'r2 CHANGED';
  lines[18] = 'r19 CHANGED';
  write(dir, 'r2.txt', `${lines.join('\n')}\n`);
  const out = await hunks.stage(dir, { file: 'r2.txt', hunks: [0] });
  assert.equal(out.ok, true, out.error);
  const staged = sh(dir, ['diff', '--cached', '-M']);
  assert.match(staged, /^rename to r2\.txt$/m, 'still a rename, now with one hunk of content on top');
  assert.match(staged, /^\+r2 CHANGED$/m);
  assert.doesNotMatch(staged, /r19 CHANGED/, 'the second hunk stayed unstaged');
  rm(dir);
});

// Rename detection needs both halves in ONE diff, and every diff here is limited to a
// single path — so a rename always reaches this layer as a delete of the old name plus
// an add of the new one. That is a feature, not a gap: each half stages independently
// and the patch we hand git never has to undo a rename to move one hunk.
test('a staged rename is modelled as two independent halves, one per path', async () => {
  const dir = repo({ 'a.txt': `${numbered(20, 'r').join('\n')}\n` });
  sh(dir, ['mv', 'a.txt', 'b.txt']);
  sh(dir, ['add', '-A']);
  const newSide = await hunks.fileHunks(dir, 'b.txt');
  const oldSide = await hunks.fileHunks(dir, 'a.txt');
  assert.equal(newSide.staged.status, 'added');
  assert.equal(oldSide.staged.status, 'deleted');
  const out = await hunks.unstage(dir, { file: 'b.txt', hunks: [0] });
  assert.equal(out.ok, true, out.error);
  assert.equal(sh(dir, ['status', '--porcelain']), 'D  a.txt\n?? b.txt\n', 'only the half we named moved');
  rm(dir);
});

test('a binary file is refused with a message pointing at file-level staging', async () => {
  const dir = repo({ 'b.bin': Buffer.from([0, 1, 2, 3]) });
  fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0, 1, 9, 9]));
  const fh = await hunks.fileHunks(dir, 'b.bin');
  assert.equal(fh.unstaged.binary, true);
  const out = await hunks.stage(dir, { file: 'b.bin', hunks: [0] });
  assert.equal(out.ok, false);
  assert.match(out.error, /binary/);
  assert.equal(cached(dir), '', 'nothing was staged');
  rm(dir);
});

test('a mode-only change is refused with a message pointing at file-level staging', async () => {
  const dir = repo({ 'm.sh': '#!/bin/sh\n' });
  fs.chmodSync(path.join(dir, 'm.sh'), 0o755);
  const fh = await hunks.fileHunks(dir, 'm.sh');
  assert.equal(fh.unstaged.modeOnly, true);
  const out = await hunks.stage(dir, { file: 'm.sh', hunks: [0] });
  assert.equal(out.ok, false);
  assert.match(out.error, /mode-only/);
  assert.equal(cached(dir), '');
  rm(dir);
});

test('a mode change alongside content rides along when a hunk is staged', async () => {
  const dir = repo({ 'm.sh': `#!/bin/sh\n${numbered(5).join('\n')}\n` });
  write(dir, 'm.sh', `#!/bin/sh\n${numbered(5).map((l, i) => (i === 2 ? 'L3 CHANGED' : l)).join('\n')}\n`);
  fs.chmodSync(path.join(dir, 'm.sh'), 0o755);
  const out = await hunks.stage(dir, { file: 'm.sh', hunks: [0] });
  assert.equal(out.ok, true, out.error);
  assert.match(cached(dir), /^new mode 100755$/m, 'the mode is part of the file header, not a hunk');
  rm(dir);
});

// ---------------------------------------------------------------------------
// Refusals — a bad request must leave the index exactly as it was
// ---------------------------------------------------------------------------

test('a stale `expect` header is refused instead of staging the wrong hunk', async () => {
  const dir = threeHunkRepo();
  const out = await hunks.stage(dir, { file: 'p.txt', hunks: [1], expect: ['@@ -999,1 +999,1 @@'] });
  assert.equal(out.ok, false);
  assert.match(out.error, /reload/);
  assert.equal(cached(dir), '', 'index untouched');
  rm(dir);
});

test('a matching `expect` header goes through', async () => {
  const dir = threeHunkRepo();
  const fh = await hunks.fileHunks(dir, 'p.txt');
  const out = await hunks.stage(dir, { file: 'p.txt', hunks: [1], expect: [fh.unstaged.hunks[1].header] });
  assert.equal(out.ok, true, out.error);
  rm(dir);
});

test('an out-of-range hunk index is refused', async () => {
  const dir = threeHunkRepo();
  const out = await hunks.stage(dir, { file: 'p.txt', hunks: [7] });
  assert.equal(out.ok, false);
  assert.match(out.error, /indexes/);
  assert.equal(cached(dir), '');
  rm(dir);
});

test('an empty hunk selection is refused rather than silently doing nothing', async () => {
  const dir = threeHunkRepo();
  const out = await hunks.stage(dir, { file: 'p.txt', hunks: [] });
  assert.equal(out.ok, false);
  rm(dir);
});

test('a file with no unstaged changes is refused', async () => {
  const dir = repo({ 'q.txt': 'unchanged\n' });
  const out = await hunks.stage(dir, { file: 'q.txt', hunks: [0] });
  assert.equal(out.ok, false);
  assert.match(out.error, /no unstaged changes/);
  rm(dir);
});

test('unstage() on a file with nothing staged is refused', async () => {
  const dir = threeHunkRepo();
  const out = await hunks.unstage(dir, { file: 'p.txt', hunks: [0] });
  assert.equal(out.ok, false);
  assert.match(out.error, /no staged changes/);
  rm(dir);
});

test('stage() without a file is refused', async () => {
  const dir = threeHunkRepo();
  assert.equal((await hunks.stage(dir, {})).ok, false);
  rm(dir);
});

// ---------------------------------------------------------------------------
// Round trip: git's own diff → our model → back to a patch git will apply
// ---------------------------------------------------------------------------

test('every serialized hunk subset of a real diff is one `git apply --cached --check` accepts', async () => {
  const dir = unbalancedRepo();
  const raw = await hunks.unstagedDiff(dir, 'o.txt');
  const [f] = parsePatch(raw);
  const subsets = [[0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]];
  for (const sel of subsets) {
    const r = applies(dir, formatFilePatch(f, sel));
    assert.equal(r.ok, true, `subset ${JSON.stringify(sel)} rejected: ${r.err}`);
  }
  rm(dir);
});

test('reverse-serialized subsets of a staged diff are ones `git apply --reverse` accepts', async () => {
  const dir = unbalancedRepo();
  sh(dir, ['add', 'o.txt']);
  const raw = await hunks.stagedDiff(dir, 'o.txt');
  const [f] = parsePatch(raw);
  for (const sel of [[0], [1], [2], [0, 2], [0, 1, 2]]) {
    const r = applies(dir, formatFilePatch(f, sel, { reverse: true }), ['--reverse']);
    assert.equal(r.ok, true, `reverse subset ${JSON.stringify(sel)} rejected: ${r.err}`);
  }
  rm(dir);
});

test('re-serializing a real diff of an awkward file reproduces git’s bytes exactly', async () => {
  const dir = repo({
    'nonl.txt': 'a\nb\nc',
    'crlf.txt': 'x\r\ny\r\nz\r\n',
    'plain.txt': `${numbered(10).join('\n')}\n`,
    'gone.txt': 'g1\ng2\n',
  });
  write(dir, 'nonl.txt', 'a\nB\nc');
  write(dir, 'crlf.txt', 'x\r\nY\r\nz\r\n');
  write(dir, 'plain.txt', `${numbered(10).map((l, i) => (i === 4 ? 'L5 CHANGED' : l)).join('\n')}\n`);
  fs.rmSync(path.join(dir, 'gone.txt'));
  write(dir, 'added.txt', 'brand\nnew\n');
  for (const file of ['nonl.txt', 'crlf.txt', 'plain.txt', 'gone.txt', 'added.txt']) {
    const raw = await hunks.unstagedDiff(dir, file);
    const [f] = parsePatch(raw);
    assert.equal(formatFilePatch(f), raw, `${file} did not round-trip byte for byte`);
    assert.equal(applies(dir, formatFilePatch(f)).ok, true, `${file} round trip is not appliable`);
  }
  rm(dir);
});
