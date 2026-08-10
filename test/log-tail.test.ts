/*
 * One tailer, for every log Studio keeps.
 *
 * Servers.logs() and Runner.logs() are the same operation on the same kind of file, and
 * runner.ts said so outright — "same contract as Servers.logs". They were not the same,
 * and the divergences were each invisible until they bit. These pin the three.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tailFile, TAIL_MAX_BYTES } from '../server/log-tail.ts';

function logFile(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-tail-'));
  const f = path.join(dir, 'out.log');
  fs.writeFileSync(f, text);
  return f;
}

test('a ROTATED log re-reads from the start instead of going silent forever', () => {
  /*
   * The divergence that actually stops a feature working. `offset > size` means the file
   * shrank — truncated or rotated — and Runner clamped `from` to `size`, so `from >= size`
   * held and it returned an empty tail on EVERY subsequent poll. The Runs panel stopped
   * updating for that run permanently, with no error anywhere.
   */
  const f = logFile('the old, long contents of a log file\n');
  const before = tailFile(f, { offset: 0 });
  assert.ok(before.text.length > 0);

  fs.writeFileSync(f, 'fresh\n'); // rotated: now much smaller than the stale offset
  const after = tailFile(f, { offset: before.offset });
  assert.equal(after.text, 'fresh\n', 'a shrunken file is re-read, not waited out');
});

test('an incremental read returns only what arrived since', () => {
  const f = logFile('one\n');
  const first = tailFile(f, { offset: 0 });
  fs.appendFileSync(f, 'two\n');
  const second = tailFile(f, { offset: first.offset });
  assert.equal(second.text, 'two\n');
  assert.equal(tailFile(f, { offset: second.offset }).text, '', 'nothing new since');
});

test('a bounded read REPORTS what it skipped', () => {
  // Without this a client cannot tell a quiet log from one it has fallen behind on.
  const f = logFile('x'.repeat(TAIL_MAX_BYTES + 5000));
  const out = tailFile(f, { offset: 0 });
  assert.ok(out.skipped > 0, 'it jumped forward and said so');
  assert.ok(out.text.length <= TAIL_MAX_BYTES);
});

test('a clipped first line is dropped, which also disposes of a split UTF-8 sequence', () => {
  // Slicing at an arbitrary byte offset lands mid-character; the tail form drops the
  // partial first line rather than rendering a replacement char.
  const f = logFile(`${'é'.repeat(TAIL_MAX_BYTES)}\nlast line\n`);
  const out = tailFile(f, { lines: 5 });
  assert.ok(!out.text.includes('�'), 'no replacement characters');
  assert.match(out.text, /last line/);
});

test('a missing file is empty rather than a throw', () => {
  assert.deepEqual(tailFile('/nope/does/not/exist'), { offset: 0, text: '', size: 0, skipped: 0 });
  assert.deepEqual(tailFile(undefined), { offset: 0, text: '', size: 0, skipped: 0 });
});
