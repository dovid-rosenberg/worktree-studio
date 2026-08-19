import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as transcripts from '../server/transcripts.ts';
import type { LocateResult } from '../server/transcripts.ts';
import type { TranscriptEntry } from '../server/types.ts';
import { present } from './helpers.ts';

/** A locate() that found the transcript; every caller below asserts on the file it names. */
function found(loc: LocateResult): Extract<LocateResult, { found: true }> {
  assert.ok(loc.found, `expected to locate a transcript, got: ${JSON.stringify(loc)}`);
  return loc;
}

/** …and its opposite: the failure branch is the one carrying `reason`. */
function notFound(loc: LocateResult): Extract<LocateResult, { found: false }> {
  assert.ok(!loc.found, `expected locate() to fail, got: ${JSON.stringify(loc)}`);
  return loc;
}

// ---- fixtures ---------------------------------------------------------------

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wts-transcripts-'));
}

// A transcript file for `cwd`/`id` inside a fake ~/.claude/projects root, so the
// slug mapping itself is exercised rather than stubbed.
function writeTranscript(root: string, cwd: string, id: string, lines: unknown[]) {
  const dir = path.join(root, transcripts.projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (lines.length ? '\n' : ''),
  );
  return file;
}

let uuidN = 0;
const nextUuid = () => `uuid-${++uuidN}`;

interface AssistantOpts {
  msgId: string;
  text: string;
  model?: string | null;
  ts?: string;
  blockType?: 'text' | 'thinking' | 'tool_use';
}
function assistantLine({
  msgId,
  text,
  model = 'claude-opus-5',
  ts = '2026-07-27T12:00:00.000Z',
  blockType = 'text',
}: AssistantOpts) {
  const block =
    blockType === 'thinking'
      ? { type: 'thinking', thinking: text }
      : blockType === 'tool_use'
        ? { type: 'tool_use', name: 'Read', input: { file_path: text } }
        : { type: 'text', text };
  return {
    type: 'assistant',
    uuid: nextUuid(),
    parentUuid: null,
    sessionId: 'cccccccc-0000-4000-8000-000000000007',
    timestamp: ts,
    cwd: '/tmp/x',
    gitBranch: 'feat/x',
    message: { id: msgId, role: 'assistant', model, content: [block] },
  };
}

function userLine({ text, ts = '2026-07-27T11:59:00.000Z' }: { text: string; ts?: string }) {
  return {
    type: 'user',
    uuid: nextUuid(),
    parentUuid: null,
    sessionId: 'cccccccc-0000-4000-8000-000000000007',
    timestamp: ts,
    cwd: '/tmp/x',
    gitBranch: 'feat/x',
    message: { role: 'user', content: text },
  };
}

// ---- slug mapping -----------------------------------------------------------

test('projectSlug replaces every non-alphanumeric byte with a dash', () => {
  assert.equal(
    transcripts.projectSlug('/Users/davidr/Desktop/code/worktree-studio'),
    '-Users-davidr-Desktop-code-worktree-studio',
  );
  // '/.worktrees/' collapses to a double dash — the case a naive slash-only replace gets wrong
  assert.equal(
    transcripts.projectSlug('/Users/d/repo/.worktrees/my-feature'),
    '-Users-d-repo--worktrees-my-feature',
  );
  assert.equal(transcripts.projectSlug('/Users/d/code/bkmark.it'), '-Users-d-code-bkmark-it');
  assert.equal(transcripts.projectSlug('/private/tmp'), '-private-tmp');
});

// ---- locate -----------------------------------------------------------------

test('locate finds a transcript under the session home dir', () => {
  const root = tempRoot();
  const cwd = '/Users/d/repo/.worktrees/feat';
  const file = writeTranscript(root, cwd, 'cccccccc-0000-4000-8000-000000000007', [userLine({ text: 'hi' })]);
  const loc = transcripts.locate(
    { home: cwd, claudeSessionId: 'cccccccc-0000-4000-8000-000000000007' },
    { root },
  );
  assert.equal(loc.found, true);
  assert.equal(found(loc).file, file);
  assert.equal(found(loc).cwd, cwd);
});

test('locate falls back to scanning project dirs when home is stale', () => {
  const root = tempRoot();
  const real = '/Users/d/repo/.worktrees/feat';
  const file = writeTranscript(root, real, 'cccccccc-0000-4000-8000-000000000008', [
    userLine({ text: 'hi' }),
  ]);
  // `home` still points at the pre-promote checkout — a /cd that never landed.
  const loc = transcripts.locate(
    { home: '/Users/d/repo', claudeSessionId: 'cccccccc-0000-4000-8000-000000000008' },
    { root },
  );
  assert.equal(loc.found, true);
  assert.equal(found(loc).file, file);
  assert.equal(found(loc).viaScan, true);
});

test('locate reports why it failed instead of throwing', () => {
  const root = tempRoot();
  assert.equal(transcripts.locate({ home: '/Users/d/repo' }, { root }).found, false);
  assert.match(notFound(transcripts.locate({ home: '/x' }, { root })).reason, /claudeSessionId/);
  assert.equal(
    transcripts.locate({ home: '/x', claudeSessionId: 'cccccccc-0000-4000-8000-000000009999' }, { root })
      .found,
    false,
  );
  assert.match(
    notFound(transcripts.locate({ home: '/x', claudeSessionId: 'nope' }, { root })).reason,
    /uuid/,
  );
});

// ---- claudeSessionId is untrusted -------------------------------------------
//
// The id arrives verbatim in a SessionStart hook payload (`session_id`) and is then
// joined into a path under ~/.claude/projects. Nothing validated it, so `../../..`
// walked straight out of the transcript root and locate() would hand the reader — and
// the indexer — any .jsonl on the machine.

test('a claudeSessionId that escapes the transcript root is refused, not resolved', () => {
  const root = tempRoot();
  const cwd = '/Users/d/repo';
  fs.mkdirSync(path.join(root, transcripts.projectSlug(cwd)), { recursive: true });

  // A real file one level ABOVE the projects root — what a traversal would reach.
  const outside = path.join(path.dirname(root), `wts-outside-${process.pid}.jsonl`);
  fs.writeFileSync(outside, '{"type":"user","uuid":"u1","message":{"role":"user","content":"secret"}}\n');
  const traversal = path
    .relative(path.join(root, transcripts.projectSlug(cwd)), outside)
    .replace(/\.jsonl$/, '');

  const loc = transcripts.locate({ home: cwd, claudeSessionId: traversal }, { root });
  // The message is evaluated eagerly, so it must not assume the branch the assertion
  // is about to rule out — `found(loc)` here would throw on the passing case.
  assert.equal(loc.found, false, `locate() resolved a traversal: ${JSON.stringify(loc)}`);
  assert.match(notFound(loc).reason, /uuid/);

  // The same shape, spelled the obvious way.
  for (const bad of ['../../..', '../../../etc/passwd', 'a/b', '..%2f..', '']) {
    assert.equal(
      transcripts.locate({ home: cwd, claudeSessionId: bad }, { root }).found,
      false,
      `accepted ${JSON.stringify(bad)}`,
    );
  }
  fs.rmSync(outside, { force: true });
});

test('isSessionId accepts a real uuid and nothing else', () => {
  assert.equal(transcripts.isSessionId('3f2a1b4c-5d6e-4f70-8901-a2b3c4d5e6f7'), true);
  assert.equal(transcripts.isSessionId('3F2A1B4C-5D6E-4F70-8901-A2B3C4D5E6F7'), true, 'case-insensitive');
  assert.equal(transcripts.isSessionId('3f2a1b4c-5d6e-4f70-8901-a2b3c4d5e6f'), false, 'too short');
  assert.equal(transcripts.isSessionId('3f2a1b4c-5d6e-4f70-8901-a2b3c4d5e6f7/x'), false);
  assert.equal(transcripts.isSessionId(null), false);
  assert.equal(transcripts.isSessionId(123), false);
});

// ---- streaming / malformed input --------------------------------------------

test('scan parses complete lines and skips malformed ones without dying', async () => {
  const root = tempRoot();
  const file = writeTranscript(root, '/tmp/a', 'cccccccc-0000-4000-8000-000000000009', [
    JSON.stringify(userLine({ text: 'one' })),
    '{ not json at all',
    '',
    '   ',
    'null',
    '[1,2,3]',
    JSON.stringify(userLine({ text: 'two' })),
  ]);
  const seen: string[] = [];
  const stats = await transcripts.scan(file, {}, (r) => {
    seen.push(String(r.type));
  });
  assert.deepEqual(seen, ['user', 'user']);
  // blank lines are not counted as lines at all; `null` and the array are structurally invalid
  assert.equal(stats.parsed, 2);
  assert.equal(stats.skipped, 3);
  assert.equal(stats.truncatedTail, false);
});

test('scan leaves a truncated final line unparsed, and picks it up once complete', async () => {
  const root = tempRoot();
  const dir = path.join(root, transcripts.projectSlug('/tmp/b'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'cs-3.jsonl');
  const whole = JSON.stringify(userLine({ text: 'complete' }));
  const partialRec = JSON.stringify(assistantLine({ msgId: 'm1', text: 'half written' }));
  const cut = partialRec.slice(0, 40); // claude is mid-write: no trailing newline, invalid JSON
  fs.writeFileSync(file, `${whole}\n${cut}`);

  const first: string[] = [];
  const s1 = await transcripts.scan(file, {}, (r) => {
    first.push(String(r.type));
  });
  assert.deepEqual(first, ['user'], 'the half-written line must not be parsed');
  assert.equal(s1.truncatedTail, true);
  assert.equal(s1.skipped, 0, 'a truncated tail is not a malformed line');
  assert.equal(s1.offset, Buffer.byteLength(`${whole}\n`), 'offset must stop at the last newline');

  // claude finishes the line
  fs.appendFileSync(file, `${partialRec.slice(40)}\n`);
  const second: string[] = [];
  const s2 = await transcripts.scan(file, { start: s1.offset }, (r) => {
    second.push(String(r.type));
  });
  assert.deepEqual(second, ['assistant'], 'resuming from the offset yields the now-complete record');
  assert.equal(s2.truncatedTail, false);
});

test('scan restarts from zero when the file shrank under us', async () => {
  const root = tempRoot();
  const file = writeTranscript(root, '/tmp/c', 'cccccccc-0000-4000-8000-000000000011', [
    userLine({ text: 'only' }),
  ]);
  const stats = await transcripts.scan(file, { start: 999999 }, () => {});
  assert.equal(stats.parsed, 1);
  assert.equal(stats.offset, stats.size);
});

test('scan tracks byte offsets correctly across multi-byte UTF-8', async () => {
  const root = tempRoot();
  const file = writeTranscript(root, '/tmp/d', 'cccccccc-0000-4000-8000-000000000014', [
    userLine({ text: 'héllo → 世界 🌍' }),
    userLine({ text: 'second' }),
  ]);
  const stats = await transcripts.scan(file, {}, () => {});
  assert.equal(stats.parsed, 2);
  assert.equal(stats.offset, fs.statSync(file).size, 'offset is byte-based, not character-based');
});

test('scan ignores line types it does not understand', async () => {
  const root = tempRoot();
  const file = writeTranscript(root, '/tmp/e', 'cccccccc-0000-4000-8000-000000000012', [
    { type: 'mode', mode: 'normal', sessionId: 'cccccccc-0000-4000-8000-000000000012' },
    { type: 'permission-mode', permissionMode: 'acceptEdits' },
    { type: 'last-prompt', leafUuid: 'x' },
    { type: 'ai-title', title: 't' },
    { type: 'file-history-snapshot', messageId: 'x' },
    { type: 'queue-operation', op: 'x' },
    { type: 'some-future-type-we-have-never-seen', payload: {} },
    userLine({ text: 'the only searchable line' }),
  ]);
  const entries: TranscriptEntry[] = [];
  await transcripts.readTranscript(file, {}, (e) => {
    entries.push(e);
  });
  assert.equal(entries.length, 1);
  assert.equal(present(entries[0]).kind, 'user');
});

// ---- direct search ----------------------------------------------------------

test('search returns role, timestamp and a snippet around the match', async () => {
  const root = tempRoot();
  const file = writeTranscript(root, '/tmp/l', 'cccccccc-0000-4000-8000-000000000004', [
    userLine({ text: 'please fix the byte offset bug in the tailer' }),
    assistantLine({ msgId: 'm1', text: 'I will look at the byte offset logic now' }),
    assistantLine({ msgId: 'm2', text: 'unrelated content' }),
  ]);
  const hits = await transcripts.search(file, { query: 'BYTE OFFSET' });
  assert.equal(hits.length, 2, 'search is case-insensitive');
  assert.equal(hits[0].role, 'user');
  assert.equal(hits[1].role, 'assistant');
  assert.ok(hits[0].ts);
  assert.match(hits[0].snippet, /byte offset/);
});

test('search honours its limit and searches tool traffic too', async () => {
  const root = tempRoot();
  const file = writeTranscript(root, '/tmp/m', 'cccccccc-0000-4000-8000-000000000002', [
    assistantLine({ msgId: 'm1', text: '/srv/needle.js', blockType: 'tool_use' }),
    assistantLine({ msgId: 'm2', text: 'needle needle', blockType: 'thinking' }),
    assistantLine({ msgId: 'm3', text: 'needle again' }),
  ]);
  assert.equal((await transcripts.search(file, { query: 'needle' })).length, 3);
  assert.equal((await transcripts.search(file, { query: 'needle', limit: 2 })).length, 2);
  assert.equal((await transcripts.search(file, { query: '' })).length, 0);
});
