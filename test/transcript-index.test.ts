import { test } from 'node:test';
import assert from 'node:assert';
import { expectErr, expectOk, present } from './helpers.ts';
import type { IndexableSession } from '../server/transcript-index.ts';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as transcripts from '../server/transcripts.ts';
import { TranscriptIndex, ftsQuery, likePattern } from '../server/transcript-index.ts';

// Each test gets its own fake ~/.claude/projects root and its own on-disk db, so the
// incremental-offset behaviour is exercised against real files rather than mocks.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-tidx-'));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(root, { recursive: true });
  const index = new TranscriptIndex({ file: path.join(dir, 'transcripts.db'), root });
  return { dir, root, index };
}

const CWD = '/Users/d/repo/.worktrees/feat';

// The five fields `index()` reads off a session, not a whole `Session` — `IndexableSession`
// is what the module declares it needs.
// `title`/`feature` are not read by index() — they ride along because the real thing
// carries them, which is the point of using a session-shaped fixture at all.
type IndexFixtureSession = IndexableSession & { title: string; feature: string };
function session(over: Partial<IndexFixtureSession> = {}): IndexFixtureSession {
  return {
    id: 's_1',
    title: 'demo',
    feature: 'feat',
    home: CWD,
    claudeSessionId: 'cccccccc-0000-4000-8000-000000000015',
    ...over,
  };
}

function transcriptFile(root: string, id = 'cccccccc-0000-4000-8000-000000000015') {
  const dir = path.join(root, transcripts.projectSlug(CWD));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.jsonl`);
}

let n = 0;
function append(file: string, records: unknown[]) {
  fs.appendFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

interface AsstOpts {
  msgId: string;
  text: string;
  model?: string | null;
  blockType?: 'text' | 'thinking';
  ts?: string;
}
function asst({
  msgId,
  text,
  model = 'claude-opus-5',
  blockType = 'text',
  ts = '2026-07-27T12:00:00.000Z',
}: AsstOpts) {
  const block = blockType === 'thinking' ? { type: 'thinking', thinking: text } : { type: 'text', text };
  return {
    type: 'assistant',
    uuid: `u${++n}`,
    sessionId: 'cccccccc-0000-4000-8000-000000000015',
    timestamp: ts,
    cwd: CWD,
    gitBranch: 'feat/x',
    requestId: `req-${msgId}`,
    message: { id: msgId, role: 'assistant', model, content: [block] },
  };
}

function user(text: string, ts = '2026-07-27T11:59:00.000Z') {
  return {
    type: 'user',
    uuid: `u${++n}`,
    sessionId: 'cccccccc-0000-4000-8000-000000000015',
    timestamp: ts,
    cwd: CWD,
    gitBranch: 'feat/x',
    message: { role: 'user', content: text },
  };
}

// ---- availability -----------------------------------------------------------

test('the index comes up on node:sqlite with FTS5', () => {
  const { index } = fixture();
  assert.equal(index.ready, true, index.error || '');
  assert.equal(index.fts, true, 'FTS5 is compiled into the bundled sqlite');
  assert.equal(index.status().backend, 'sqlite-fts5');
  index.close();
});

// ---- incremental indexing ---------------------------------------------------

test('indexing is incremental: a second pass reads no bytes', async () => {
  const { root, index } = fixture();
  const file = transcriptFile(root);
  append(file, [user('first prompt'), asst({ msgId: 'm1', text: 'first answer' })]);

  const p1 = expectOk(await index.index(session()));
  assert.equal(p1.ok, true);
  assert.equal(p1.added, 2);
  assert.equal(p1.offset, fs.statSync(file).size);

  const p2 = expectOk(await index.index(session()));
  assert.equal(p2.added, 0);
  assert.equal(p2.upToDate, true, 'no new bytes → no re-read');

  append(file, [asst({ msgId: 'm2', text: 'second answer' })]);
  const p3 = expectOk(await index.index(session()));
  assert.equal(p3.added, 1, 'only the appended record is read');
  assert.equal(p3.offset, fs.statSync(file).size);
  assert.equal(index.status().messages, 3);
  index.close();
});

test('re-indexing the same bytes is idempotent', async () => {
  const { root, index } = fixture();
  const file = transcriptFile(root);
  append(file, [user('hello'), asst({ msgId: 'm1', text: 'hi' })]);
  await index.index(session());
  const before = index.status().messages;

  await index.index(session(), { full: true }); // force a full re-read from offset 0
  assert.equal(index.status().messages, before, 'unique(session,uuid) absorbs the replay');
  assert.equal(
    expectOk(index.search('hi')).total,
    1,
    'and the FTS shadow table does not gain a duplicate hit either',
  );
  index.close();
});

test('a truncated tail is indexed only once it is complete', async () => {
  const { root, index } = fixture();
  const file = transcriptFile(root);
  const rec = JSON.stringify(asst({ msgId: 'm1', text: 'a complete answer' }));
  fs.writeFileSync(file, `${JSON.stringify(user('go'))}\n${rec.slice(0, 30)}`);

  const p1 = expectOk(await index.index(session()));
  assert.equal(p1.added, 1, 'the half-written assistant line is not indexed');
  assert.equal(p1.truncatedTail, true);

  fs.appendFileSync(file, `${rec.slice(30)}\n`);
  const p2 = expectOk(await index.index(session()));
  assert.equal(p2.added, 1, 'the completed line is picked up on the next pass');
  assert.equal(expectOk(index.search('complete answer')).total, 1, 'and is searchable');
  index.close();
});

test('a relocated transcript is re-read from the start, not from a stale offset', async () => {
  const { root, index } = fixture();
  const oldCwd = '/Users/d/repo';
  const oldDir = path.join(root, transcripts.projectSlug(oldCwd));
  fs.mkdirSync(oldDir, { recursive: true });
  const oldFile = path.join(oldDir, 'cccccccc-0000-4000-8000-000000000015.jsonl');
  append(oldFile, [user('pre-promote'), asst({ msgId: 'm1', text: 'before' })]);
  await index.index(session({ home: oldCwd }));
  assert.equal(index.status().messages, 2);

  // promote: /cd moves cwd AND the transcript, which carries the whole history over
  const newFile = transcriptFile(root);
  append(newFile, [
    user('pre-promote'),
    asst({ msgId: 'm1', text: 'before' }),
    asst({ msgId: 'm2', text: 'after' }),
  ]);
  const p = expectOk(await index.index(session({ home: CWD })));
  assert.equal(p.file, newFile);
  assert.equal(p.added, 3, 'the moved file is read whole rather than sliced at the old offset');
  index.close();
});

test('malformed lines are counted and skipped without stalling the offset', async () => {
  const { root, index } = fixture();
  const file = transcriptFile(root);
  fs.writeFileSync(
    file,
    `${[
      JSON.stringify(user('good one')),
      '{ broken json',
      JSON.stringify(asst({ msgId: 'm1', text: 'good two' })),
    ].join('\n')}\n`,
  );
  const p = expectOk(await index.index(session()));
  assert.equal(p.added, 2);
  assert.equal(p.malformedLines, 1);
  assert.equal(p.offset, fs.statSync(file).size, 'a bad line does not pin the offset');
  index.close();
});

test('forget drops a closed session from the index', async () => {
  const { root, index } = fixture();
  append(transcriptFile(root), [user('hello'), asst({ msgId: 'm1', text: 'bye' })]);
  await index.index(session());
  assert.equal(index.status().messages, 2);
  index.forget('s_1');
  assert.equal(index.status().messages, 0);
  assert.equal(index.status().sessions, 0);
  assert.equal(expectOk(index.search('bye')).total, 0, 'the FTS shadow table is cleaned up too');
  index.close();
});

test('index reports why it cannot find a transcript', async () => {
  const { index } = fixture();
  assert.equal((await index.index(session({ claudeSessionId: null }))).ok, false);
  assert.match(
    expectErr(await index.index(session({ claudeSessionId: 'cccccccc-0000-4000-8000-000000009999' }))).reason,
    /not found/,
  );
  // Not a uuid → refused before it can be joined into a path at all (see locate()).
  assert.match(expectErr(await index.index(session({ claudeSessionId: 'missing' }))).reason, /uuid/);
  index.close();
});

// ---- search -----------------------------------------------------------------

test('search returns text, session, role and timestamp', async () => {
  const { root, index } = fixture();
  append(transcriptFile(root), [
    user('please fix the byte offset bug', '2026-07-27T10:00:00.000Z'),
    asst({ msgId: 'm1', text: 'looking at the byte offset logic', ts: '2026-07-27T10:01:00.000Z' }),
    asst({ msgId: 'm2', text: 'something else entirely', ts: '2026-07-27T10:02:00.000Z' }),
  ]);
  await index.index(session());
  const out = expectOk(index.search('byte offset'));
  assert.equal(out.ok, true);
  assert.equal(out.backend, 'sqlite-fts5');
  assert.equal(out.total, 2);
  for (const h of out.hits) {
    assert.equal(h.sessionId, 's_1');
    assert.ok(h.uuid && h.ts && h.role);
    assert.match(h.snippet, /byte|offset/i);
  }
  assert.deepEqual(out.hits.map((h) => h.role).sort(), ['assistant', 'user']);
  index.close();
});

test('search filters by session, role and time', async () => {
  const { root, index } = fixture();
  append(transcriptFile(root), [
    user('needle in the prompt', '2026-07-27T10:00:00.000Z'),
    asst({ msgId: 'm1', text: 'needle in the answer', ts: '2026-07-27T12:00:00.000Z' }),
  ]);
  await index.index(session());
  assert.equal(expectOk(index.search('needle', { role: 'user' })).total, 1);
  assert.equal(expectOk(index.search('needle', { sessionId: 's_other' })).total, 0);
  assert.equal(expectOk(index.search('needle', { since: Date.parse('2026-07-27T11:00:00.000Z') })).total, 1);
  assert.equal(expectOk(index.search('needle', { limit: 1 })).total, 1);
  index.close();
});

test('all terms must match — search is an AND, not an OR', async () => {
  const { root, index } = fixture();
  append(transcriptFile(root), [user('alpha only'), asst({ msgId: 'm1', text: 'alpha and beta together' })]);
  await index.index(session());
  assert.equal(expectOk(index.search('alpha')).total, 2);
  assert.equal(expectOk(index.search('alpha beta')).total, 1);
  index.close();
});

test('FTS5 operators in user input are searched literally, not executed', async () => {
  const { root, index } = fixture();
  append(transcriptFile(root), [user('the NEAR keyword and an OR clause')]);
  await index.index(session());
  // Each of these is a syntax error if passed raw to MATCH.
  for (const q of ['OR', 'NEAR', 'a"b', '"unbalanced', '*', 'AND OR NOT']) {
    assert.doesNotThrow(() => expectOk(index.search(q)), `query ${JSON.stringify(q)} must not throw`);
  }
  assert.equal(expectOk(index.search('OR clause')).total, 1);
  index.close();
});

test('ftsQuery quotes every term and returns null for an empty query', () => {
  assert.equal(ftsQuery('byte offset'), '"byte" AND "offset"');
  assert.equal(ftsQuery('  '), null);
  assert.equal(ftsQuery('"'), null);
  assert.ok(
    !present(ftsQuery('a"b'), 'a compiled query').includes('a"b'),
    'the embedded quote is neutralised',
  );
});

test('likePattern escapes sql wildcards so they are searched, not matched', () => {
  assert.equal(likePattern('100%'), '%100\\%%');
  assert.equal(likePattern('a_b'), '%a\\_b%');
});
