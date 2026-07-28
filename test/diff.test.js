// The pure diff model (server/diff.js): parsing, side-by-side row alignment, and
// serializing a subset of a file's hunks. No git here on purpose — every case below is
// a fixture patch, which is why the awkward ones (no trailing newline, CRLF, renames,
// binary, mode-only, offset recomputation) are cheap to pin down. test/hunks.test.js
// then proves the same patches survive a real `git apply`.
import { test } from 'node:test';
import assert from 'node:assert';
import { parsePatch, formatFilePatch, alignRows, normalizeSelection, stripPrefix, unquotePath } from '../server/diff.js';

// Patch fixtures are built line-by-line so trailing whitespace and the "\ No newline"
// marker are visible and exact.
const P = (...lines) => `${lines.join('\n')}\n`;

const MODIFIED = P(
  'diff --git a/keep.txt b/keep.txt',
  'index de98044..7be73ce 100644',
  '--- a/keep.txt',
  '+++ b/keep.txt',
  '@@ -1,4 +1,4 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  ' d',
);

// Three hunks with UNBALANCED line counts: +4, -2, 0. Any subset of these needs the
// `@@` new-side offsets recomputed, which is where hunk staging usually goes wrong.
const THREE_HUNKS = P(
  'diff --git a/o.txt b/o.txt',
  'index 2b3c10c..227b439 100644',
  '--- a/o.txt',
  '+++ b/o.txt',
  '@@ -1,6 +1,10 @@',
  ' b1',
  ' b2',
  ' b3',
  '+ins1',
  '+ins2',
  '+ins3',
  '+ins4',
  ' b4',
  ' b5',
  ' b6',
  '@@ -22,8 +26,6 @@ b21',
  ' b22',
  ' b23',
  ' b24',
  '-b25',
  '-b26',
  ' b27',
  ' b28',
  ' b29',
  '@@ -47,7 +49,7 @@ b46',
  ' b47',
  ' b48',
  ' b49',
  '-b50',
  '+b50X',
  ' b51',
  ' b52',
  ' b53',
);

const NO_NEWLINE = P(
  'diff --git a/n.txt b/n.txt',
  'index 1c943a9..1aa51b9 100644',
  '--- a/n.txt',
  '+++ b/n.txt',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '-c',
  '\\ No newline at end of file',
  '+B',
  '+C',
  '\\ No newline at end of file',
);

const CRLF = P(
  'diff --git a/c.txt b/c.txt',
  'index 04ec35a..20a747d 100644',
  '--- a/c.txt',
  '+++ b/c.txt',
  '@@ -1,3 +1,3 @@',
  ' x\r',
  '-y\r',
  '+Y\r',
  ' z\r',
);

const NEW_FILE = P(
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..5804e55',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+n1',
  '+n2',
);

const DELETED_FILE = P(
  'diff --git a/del.txt b/del.txt',
  'deleted file mode 100644',
  'index ddbe444..0000000',
  '--- a/del.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-d1',
  '-d2',
);

const RENAMED = P(
  'diff --git a/r.txt b/r2.txt',
  'similarity index 94%',
  'rename from r.txt',
  'rename to r2.txt',
  'index 2749a43..7206d18 100644',
  '--- a/r.txt',
  '+++ b/r2.txt',
  '@@ -1,3 +1,3 @@',
  ' r1',
  '-r2',
  '+r2X',
  ' r3',
);

const BINARY = P(
  'diff --git a/b.bin b/b.bin',
  'index 6772730..4e0e1df 100644',
  'Binary files a/b.bin and b/b.bin differ',
);

const MODE_ONLY = P(
  'diff --git a/m.sh b/m.sh',
  'old mode 100644',
  'new mode 100755',
);

const headersOf = (patch) => patch.split('\n').filter((l) => l.startsWith('@@'));

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parsePatch reads path, status and hunk geometry from a modified file', () => {
  const [f] = parsePatch(MODIFIED);
  assert.equal(f.path, 'keep.txt');
  assert.equal(f.status, 'modified');
  assert.equal(f.binary, false);
  assert.equal(f.hunks.length, 1);
  assert.deepEqual(
    [f.hunks[0].oldStart, f.hunks[0].oldLines, f.hunks[0].newStart, f.hunks[0].newLines],
    [1, 4, 1, 4],
  );
});

test('parsePatch numbers each line on the side it belongs to', () => {
  const [f] = parsePatch(MODIFIED);
  assert.deepEqual(
    f.hunks[0].lines.map((l) => [l.type, l.oldLine, l.newLine, l.text]),
    [
      ['context', 1, 1, 'a'],
      ['del', 2, null, 'b'],
      ['add', null, 2, 'B'],
      ['context', 3, 3, 'c'],
      ['context', 4, 4, 'd'],
    ],
  );
});

test('parsePatch counts added and deleted lines per hunk and per file', () => {
  const [f] = parsePatch(THREE_HUNKS);
  assert.deepEqual(f.hunks.map((h) => [h.added, h.deleted]), [[4, 0], [0, 2], [1, 1]]);
  assert.equal(f.added, 5);
  assert.equal(f.deleted, 3);
});

test('parsePatch keeps the @@ section heading with its hunk', () => {
  const [f] = parsePatch(THREE_HUNKS);
  assert.equal(f.hunks[1].section, ' b21');
  assert.equal(f.hunks[0].section, '');
});

test('parsePatch splits a multi-file patch into one entry per file', () => {
  const files = parsePatch(MODIFIED + NEW_FILE + DELETED_FILE);
  assert.deepEqual(files.map((f) => [f.path, f.status]), [
    ['keep.txt', 'modified'], ['new.txt', 'added'], ['del.txt', 'deleted'],
  ]);
});

test('parsePatch ignores the commit header `git show` prints before the first diff', () => {
  const files = parsePatch(`commit abc123\nAuthor: t <t@t.t>\n\n    subject line\n\n${MODIFIED}`);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'keep.txt');
});

test('parsePatch tolerates non-standard diff prefixes (diff.mnemonicPrefix gives c/ and w/)', () => {
  const [f] = parsePatch(MODIFIED.replace(/a\/keep/g, 'c/keep').replace(/b\/keep/g, 'w/keep'));
  assert.equal(f.path, 'keep.txt');
  assert.equal(f.oldPath, 'keep.txt');
});

test('parsePatch attaches "\\ No newline at end of file" to the line it belongs to', () => {
  const [f] = parsePatch(NO_NEWLINE);
  assert.deepEqual(
    f.hunks[0].lines.map((l) => [l.type, l.text, !!l.noNewline]),
    [['context', 'a', false], ['del', 'b', false], ['del', 'c', true], ['add', 'B', false], ['add', 'C', true]],
  );
});

test('parsePatch keeps the \\r of a CRLF file inside the line text', () => {
  const [f] = parsePatch(CRLF);
  assert.deepEqual(f.hunks[0].lines.map((l) => l.text), ['x\r', 'y\r', 'Y\r', 'z\r']);
});

test('parsePatch marks a new file as added with no old path', () => {
  const [f] = parsePatch(NEW_FILE);
  assert.equal(f.status, 'added');
  assert.equal(f.oldPath, null);
  assert.equal(f.path, 'new.txt');
  assert.equal(f.newMode, '100644');
  assert.equal(f.hunks[0].oldStart, 0);
});

test('parsePatch marks a deleted file as deleted with no new path', () => {
  const [f] = parsePatch(DELETED_FILE);
  assert.equal(f.status, 'deleted');
  assert.equal(f.newPath, null);
  assert.equal(f.path, 'del.txt');
});

test('parsePatch reads a rename’s old and new paths and similarity', () => {
  const [f] = parsePatch(RENAMED);
  assert.equal(f.status, 'renamed');
  assert.equal(f.oldPath, 'r.txt');
  assert.equal(f.newPath, 'r2.txt');
  assert.equal(f.similarity, 94);
  assert.equal(f.hunks.length, 1);
});

test('parsePatch flags a binary file and gives it no hunks', () => {
  const [f] = parsePatch(BINARY);
  assert.equal(f.binary, true);
  assert.equal(f.path, 'b.bin');
  assert.deepEqual(f.hunks, []);
});

test('parsePatch flags a mode-only change, which has no ---/+++ lines at all', () => {
  const [f] = parsePatch(MODE_ONLY);
  assert.equal(f.modeOnly, true);
  assert.equal(f.oldMode, '100644');
  assert.equal(f.newMode, '100755');
  assert.equal(f.path, 'm.sh');
  assert.deepEqual(f.hunks, []);
});

test('parsePatch flags a combined (merge) diff as unsupported rather than mis-parsing it', () => {
  const combined = P(
    'diff --cc merged.txt',
    'index 1111111,2222222..3333333',
    '--- a/merged.txt',
    '+++ b/merged.txt',
    '@@@ -1,2 -1,2 +1,2 @@@',
    '  ours',
    '- theirs',
  );
  const [f] = parsePatch(`diff --git a/merged.txt b/merged.txt\n${combined.split('\n').slice(1).join('\n')}`);
  assert.equal(f.unsupported, 'combined');
  assert.deepEqual(f.hunks, []);
});

test('parsePatch treats a bare unified diff (no `diff --git` header) as one file', () => {
  const [f] = parsePatch(P('--- a/x.txt', '+++ b/x.txt', '@@ -1 +1 @@', '-old', '+new'));
  assert.equal(f.path, 'x.txt');
  assert.equal(f.hunks.length, 1);
});

test('parsePatch returns nothing for text that is not a diff', () => {
  assert.deepEqual(parsePatch('just some prose\n'), []);
  assert.deepEqual(parsePatch(''), []);
});

test('stripPrefix drops the prefix component and maps /dev/null to null', () => {
  assert.equal(stripPrefix('a/src/x.js'), 'src/x.js');
  assert.equal(stripPrefix('w/src/x.js'), 'src/x.js');
  assert.equal(stripPrefix('/dev/null'), null);
});

test('unquotePath decodes git’s C-quoted octal escapes for non-ASCII names', () => {
  assert.equal(unquotePath('"\\303\\244.txt"'), 'ä.txt');
  assert.equal(unquotePath('plain.txt'), 'plain.txt');
});

// ---------------------------------------------------------------------------
// Side-by-side rows
// ---------------------------------------------------------------------------

test('alignRows pairs a removed line with the addition that replaces it', () => {
  const [f] = parsePatch(MODIFIED);
  assert.deepEqual(f.hunks[0].rows, [
    { type: 'context', left: 0, right: 0 },
    { type: 'change', left: 1, right: 2 },
    { type: 'context', left: 3, right: 3 },
    { type: 'context', left: 4, right: 4 },
  ]);
});

test('alignRows leaves a pure insertion with an empty left side', () => {
  const [f] = parsePatch(THREE_HUNKS);
  const inserts = f.hunks[0].rows.filter((r) => r.type === 'add');
  assert.equal(inserts.length, 4);
  assert.ok(inserts.every((r) => r.left === null));
});

test('alignRows leaves a pure deletion with an empty right side', () => {
  const [f] = parsePatch(THREE_HUNKS);
  const removals = f.hunks[1].rows.filter((r) => r.type === 'del');
  assert.equal(removals.length, 2);
  assert.ok(removals.every((r) => r.right === null));
});

test('alignRows pairs what it can and spills the rest into one-sided rows', () => {
  // 3 removals against 1 addition → one paired change row, two lone removals.
  /** @type {Array<{ type: import('../server/types.ts').DiffLineType, text: string }>} */
  const lines = [
    { type: 'del', text: 'a' }, { type: 'del', text: 'b' }, { type: 'del', text: 'c' },
    { type: 'add', text: 'A' },
  ];
  assert.deepEqual(alignRows(lines), [
    { type: 'change', left: 0, right: 3 },
    { type: 'del', left: 1, right: null },
    { type: 'del', left: 2, right: null },
  ]);
});

test('rows index into lines, so unified and side-by-side render from one payload', () => {
  const [f] = parsePatch(MODIFIED);
  const h = f.hunks[0];
  const change = h.rows.find((r) => r.type === 'change');
  assert.equal(h.lines[change.left].text, 'b');
  assert.equal(h.lines[change.right].text, 'B');
});

// ---------------------------------------------------------------------------
// Serializing (the part git apply has to accept)
// ---------------------------------------------------------------------------

test('formatFilePatch with every hunk selected reproduces the input byte for byte', () => {
  for (const fixture of [MODIFIED, THREE_HUNKS, NO_NEWLINE, CRLF, NEW_FILE, DELETED_FILE, RENAMED]) {
    const [f] = parsePatch(fixture);
    assert.equal(formatFilePatch(f), fixture);
  }
});

test('formatFilePatch round-trips `@@ -1 +1 @@` without inventing a ,1 count', () => {
  const one = P('diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-old', '+new');
  assert.equal(formatFilePatch(parsePatch(one)[0]), one);
});

test('formatFilePatch shifts a later hunk back by the lines the dropped hunks would have added', () => {
  // Dropping hunk 0 (+4) and hunk 1 (−2) leaves a net +2 that never happens, so the
  // last hunk lands 2 lines earlier than the full patch says.
  const [f] = parsePatch(THREE_HUNKS);
  assert.deepEqual(headersOf(formatFilePatch(f, [2])), ['@@ -47,7 +47,7 @@ b46']);
});

test('formatFilePatch recomputes every kept hunk against the hunks kept before it', () => {
  const [f] = parsePatch(THREE_HUNKS);
  assert.deepEqual(headersOf(formatFilePatch(f, [1, 2])), ['@@ -22,8 +22,6 @@ b21', '@@ -47,7 +45,7 @@ b46']);
});

test('formatFilePatch leaves the old side alone when staging (the index is the source)', () => {
  const [f] = parsePatch(THREE_HUNKS);
  const emitted = headersOf(formatFilePatch(f, [1, 2])).map((h) => h.split(' ')[1]);
  assert.deepEqual(emitted, ['-22,8', '-47,7'], 'pre-image positions are untouched');
});

test('formatFilePatch shifts the OLD side when reversing (git apply --reverse reads the new side)', () => {
  // Un-applying only hunk 2 leaves hunks 0 (+4) and 1 (−2) in place, so the line the
  // reversal lands on sits 2 lines LATER than the full patch's pre-image says.
  const [f] = parsePatch(THREE_HUNKS);
  assert.deepEqual(headersOf(formatFilePatch(f, [2], { reverse: true })), ['@@ -49,7 +49,7 @@ b46']);
});

test('formatFilePatch keeps a rename’s headers on a hunk subset, so the rename still happens', () => {
  const [f] = parsePatch(RENAMED);
  const patch = formatFilePatch(f, [0]);
  assert.match(patch, /^rename from r\.txt$/m);
  assert.match(patch, /^rename to r2\.txt$/m);
});

test('formatFilePatch carries the "\\ No newline" marker with the line it belongs to', () => {
  const [f] = parsePatch(NO_NEWLINE);
  const patch = formatFilePatch(f, [0]);
  assert.equal(patch.match(/\\ No newline at end of file/g).length, 2);
});

test('formatFilePatch with an empty selection emits the header and no hunks', () => {
  const [f] = parsePatch(THREE_HUNKS);
  assert.deepEqual(headersOf(formatFilePatch(f, [])), []);
});

test('normalizeSelection sorts, de-dupes and drops out-of-range indexes', () => {
  assert.deepEqual(normalizeSelection([2, 0, 2, 9, -1], 3), [0, 2]);
  assert.deepEqual(normalizeSelection(null, 3), [0, 1, 2], 'null means every hunk');
  assert.deepEqual(normalizeSelection(1, 3), [1], 'a bare number is a one-hunk selection');
});
