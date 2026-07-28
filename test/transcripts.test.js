'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const transcripts = require('../server/transcripts');
const pricing = require('../server/pricing');

// ---- fixtures ---------------------------------------------------------------

function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wts-transcripts-')); }

// A transcript file for `cwd`/`id` inside a fake ~/.claude/projects root, so the
// slug mapping itself is exercised rather than stubbed.
function writeTranscript(root, cwd, id, lines) {
  const dir = path.join(root, transcripts.projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (lines.length ? '\n' : ''));
  return file;
}

let uuidN = 0;
const nextUuid = () => `uuid-${++uuidN}`;

function usage(over = {}) {
  return {
    input_tokens: 10,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 5000,
    output_tokens: 100,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
    ...over,
  };
}

function assistantLine({ msgId, text, model = 'claude-opus-5', use = usage(), ts = '2026-07-27T12:00:00.000Z', blockType = 'text' }) {
  const block = blockType === 'thinking' ? { type: 'thinking', thinking: text }
    : blockType === 'tool_use' ? { type: 'tool_use', name: 'Read', input: { file_path: text } }
      : { type: 'text', text };
  return {
    type: 'assistant', uuid: nextUuid(), parentUuid: null, sessionId: 'cccccccc-0000-4000-8000-000000000007', timestamp: ts,
    cwd: '/tmp/x', gitBranch: 'feat/x', requestId: `req-${msgId}`,
    message: { id: msgId, role: 'assistant', model, content: [block], usage: use },
  };
}

function userLine({ text, ts = '2026-07-27T11:59:00.000Z' }) {
  return {
    type: 'user', uuid: nextUuid(), parentUuid: null, sessionId: 'cccccccc-0000-4000-8000-000000000007', timestamp: ts,
    cwd: '/tmp/x', gitBranch: 'feat/x', message: { role: 'user', content: text },
  };
}

// ---- slug mapping -----------------------------------------------------------

test('projectSlug replaces every non-alphanumeric byte with a dash', () => {
  assert.equal(transcripts.projectSlug('/Users/davidr/Desktop/code/worktree-studio'),
    '-Users-davidr-Desktop-code-worktree-studio');
  // '/.worktrees/' collapses to a double dash — the case a naive slash-only replace gets wrong
  assert.equal(transcripts.projectSlug('/Users/d/repo/.worktrees/my-feature'),
    '-Users-d-repo--worktrees-my-feature');
  assert.equal(transcripts.projectSlug('/Users/d/code/bkmark.it'), '-Users-d-code-bkmark-it');
  assert.equal(transcripts.projectSlug('/private/tmp'), '-private-tmp');
});

// ---- locate -----------------------------------------------------------------

test('locate finds a transcript under the session home dir', () => {
  const root = tempRoot();
  const cwd = '/Users/d/repo/.worktrees/feat';
  const file = writeTranscript(root, cwd, 'cccccccc-0000-4000-8000-000000000007', [userLine({ text: 'hi' })]);
  const loc = transcripts.locate({ home: cwd, claudeSessionId: 'cccccccc-0000-4000-8000-000000000007' }, { root });
  assert.equal(loc.found, true);
  assert.equal(loc.file, file);
  assert.equal(loc.cwd, cwd);
});

test('locate falls back to scanning project dirs when home is stale', () => {
  const root = tempRoot();
  const real = '/Users/d/repo/.worktrees/feat';
  const file = writeTranscript(root, real, 'cccccccc-0000-4000-8000-000000000008', [userLine({ text: 'hi' })]);
  // `home` still points at the pre-promote checkout — a /cd that never landed.
  const loc = transcripts.locate({ home: '/Users/d/repo', claudeSessionId: 'cccccccc-0000-4000-8000-000000000008' }, { root });
  assert.equal(loc.found, true);
  assert.equal(loc.file, file);
  assert.equal(loc.viaScan, true);
});

test('locate reports why it failed instead of throwing', () => {
  const root = tempRoot();
  assert.equal(transcripts.locate({ home: '/Users/d/repo' }, { root }).found, false);
  assert.match(transcripts.locate({ home: '/x' }, { root }).reason, /claudeSessionId/);
  assert.equal(transcripts.locate({ home: '/x', claudeSessionId: 'cccccccc-0000-4000-8000-000000009999' }, { root }).found, false);
  assert.match(transcripts.locate({ home: '/x', claudeSessionId: 'nope' }, { root }).reason, /uuid/);
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
  const escape = path.relative(path.join(root, transcripts.projectSlug(cwd)), outside).replace(/\.jsonl$/, '');

  const loc = transcripts.locate({ home: cwd, claudeSessionId: escape }, { root });
  assert.equal(loc.found, false, `locate() resolved a traversal to ${loc.file}`);
  assert.match(loc.reason, /uuid/);

  // The same shape, spelled the obvious way.
  for (const bad of ['../../..', '../../../etc/passwd', 'a/b', '..%2f..', '']) {
    assert.equal(transcripts.locate({ home: cwd, claudeSessionId: bad }, { root }).found, false, `accepted ${JSON.stringify(bad)}`);
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
  const seen = [];
  const stats = await transcripts.scan(file, {}, (r) => { seen.push(r.type); });
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

  const first = [];
  const s1 = await transcripts.scan(file, {}, (r) => { first.push(r.type); });
  assert.deepEqual(first, ['user'], 'the half-written line must not be parsed');
  assert.equal(s1.truncatedTail, true);
  assert.equal(s1.skipped, 0, 'a truncated tail is not a malformed line');
  assert.equal(s1.offset, Buffer.byteLength(`${whole}\n`), 'offset must stop at the last newline');

  // claude finishes the line
  fs.appendFileSync(file, `${partialRec.slice(40)}\n`);
  const second = [];
  const s2 = await transcripts.scan(file, { start: s1.offset }, (r) => { second.push(r.type); });
  assert.deepEqual(second, ['assistant'], 'resuming from the offset yields the now-complete record');
  assert.equal(s2.truncatedTail, false);
});

test('scan restarts from zero when the file shrank under us', async () => {
  const root = tempRoot();
  const file = writeTranscript(root, '/tmp/c', 'cccccccc-0000-4000-8000-000000000011', [userLine({ text: 'only' })]);
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
  const entries = [];
  await transcripts.readTranscript(file, {}, (e) => entries.push(e));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'user');
});

// ---- usage normalization ----------------------------------------------------

test('normalizeUsage splits cache writes by TTL', () => {
  const u = transcripts.normalizeUsage(usage({
    cache_creation_input_tokens: 15897,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 15897 },
  }));
  assert.equal(u.cacheWrite1h, 15897);
  assert.equal(u.cacheWrite5m, 0);
  assert.equal(u.cacheWrite, 15897);
});

test('normalizeUsage treats an absent breakdown as a 5m write', () => {
  const raw = usage({ cache_creation_input_tokens: 500 });
  delete raw.cache_creation;
  const u = transcripts.normalizeUsage(raw);
  assert.equal(u.cacheWrite5m, 500);
  assert.equal(u.cacheWrite1h, 0);
});

test('normalizeUsage reconciles a breakdown that disagrees with the total', () => {
  const u = transcripts.normalizeUsage(usage({
    cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 400 },
  }));
  assert.equal(u.cacheWrite1h, 400);
  assert.equal(u.cacheWrite5m, 600, 'the remainder is attributed to the cheaper 5m bucket');
  assert.equal(u.cacheWrite1h + u.cacheWrite5m, 1000);
});

test('normalizeUsage tolerates missing and non-numeric fields', () => {
  assert.equal(transcripts.normalizeUsage(null), null);
  assert.equal(transcripts.normalizeUsage('nope'), null);
  const u = transcripts.normalizeUsage({ input_tokens: 'x', output_tokens: null });
  assert.equal(u.input, 0);
  assert.equal(u.output, 0);
  assert.equal(u.cacheRead, 0);
});

// ---- aggregation ------------------------------------------------------------

test('aggregate dedupes the repeated usage Claude Code writes per content block', async () => {
  const root = tempRoot();
  // ONE API response, written as four JSONL lines (thinking + text + 2 tool_use),
  // each repeating the identical usage. This is the real format — summing lines
  // would report 4x the tokens actually billed.
  const use = usage({ input_tokens: 2, output_tokens: 1017, cache_creation_input_tokens: 0, cache_read_input_tokens: 20576, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
  const file = writeTranscript(root, '/tmp/f', 'cccccccc-0000-4000-8000-000000000010', [
    assistantLine({ msgId: 'msg_A', text: 'thinking...', use, blockType: 'thinking' }),
    assistantLine({ msgId: 'msg_A', text: 'here is the answer', use, blockType: 'text' }),
    assistantLine({ msgId: 'msg_A', text: '/a.js', use, blockType: 'tool_use' }),
    assistantLine({ msgId: 'msg_A', text: '/b.js', use, blockType: 'tool_use' }),
  ]);
  const agg = await transcripts.aggregate(file);
  assert.equal(agg.assistantMessages, 1, 'four lines are one billed response');
  assert.equal(agg.output, 1017);
  assert.equal(agg.input, 2);
  assert.equal(agg.cacheRead, 20576);
});

test('aggregate sums distinct responses and reports per-model breakdowns', async () => {
  const root = tempRoot();
  const file = writeTranscript(root, '/tmp/g', 'cccccccc-0000-4000-8000-000000000013', [
    userLine({ text: 'do the thing' }),
    assistantLine({ msgId: 'm1', text: 'a', use: usage({ input_tokens: 10, output_tokens: 100 }) }),
    assistantLine({ msgId: 'm2', text: 'b', use: usage({ input_tokens: 20, output_tokens: 200 }) }),
    assistantLine({ msgId: 'm3', text: 'c', model: 'claude-haiku-4-5', use: usage({ input_tokens: 5, output_tokens: 50 }) }),
  ]);
  const agg = await transcripts.aggregate(file);
  assert.equal(agg.assistantMessages, 3);
  assert.equal(agg.userMessages, 1);
  assert.equal(agg.input, 35);
  assert.equal(agg.output, 350);
  assert.equal(agg.byModel.length, 2);
  const opus = agg.byModel.find((m) => m.model === 'claude-opus-5');
  assert.equal(opus.messages, 2);
  assert.equal(opus.output, 300);
  assert.equal(agg.costIsEstimate, true);
  assert.deepEqual(agg.unpricedModels, []);
});

test('aggregate records the transcript time span', async () => {
  const root = tempRoot();
  const file = writeTranscript(root, '/tmp/h', 'cccccccc-0000-4000-8000-000000000001', [
    userLine({ text: 'first', ts: '2026-07-27T10:00:00.000Z' }),
    assistantLine({ msgId: 'm1', text: 'last', ts: '2026-07-27T10:05:00.000Z' }),
  ]);
  const agg = await transcripts.aggregate(file);
  assert.equal(agg.firstAt, Date.parse('2026-07-27T10:00:00.000Z'));
  assert.equal(agg.lastAt, Date.parse('2026-07-27T10:05:00.000Z'));
});

test('aggregate counts a response with no message id exactly once', async () => {
  const root = tempRoot();
  const line = assistantLine({ msgId: 'm1', text: 'x', use: usage({ output_tokens: 7 }) });
  delete line.message.id;
  delete line.requestId;
  const file = writeTranscript(root, '/tmp/i', 'cccccccc-0000-4000-8000-000000000006', [line]);
  const agg = await transcripts.aggregate(file);
  assert.equal(agg.assistantMessages, 1, 'falls back to the line uuid rather than dropping the record');
  assert.equal(agg.output, 7);
});

// ---- cost -------------------------------------------------------------------

test('costOf applies input, output and both cache multipliers', () => {
  // claude-opus-5 is $5/M input, $25/M output. Cache: 5m write 1.25x, 1h write 2x,
  // read 0.1x — all multiples of the INPUT rate.
  const { usd, priced } = pricing.costOf('claude-opus-5', {
    input: 1e6, output: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6,
  });
  assert.equal(priced, true);
  // 5 + 25 + (5*1.25) + (5*2) + (5*0.1) = 46.75
  assert.equal(pricing.round(usd), 46.75);
});

test('costOf reproduces a real transcript total', () => {
  // Numbers taken from an actual worktree-studio session transcript.
  const { usd } = pricing.costOf('claude-opus-5', {
    input: 546, output: 72521, cacheWrite5m: 0, cacheWrite1h: 153587, cacheRead: 7139352,
  });
  assert.equal(pricing.round(usd), 6.921301);
});

test('costOf prices fast mode on its own SKU', () => {
  const std = pricing.costOf('claude-opus-5', { input: 1e6, output: 0 }, { speed: 'standard' });
  const fast = pricing.costOf('claude-opus-5', { input: 1e6, output: 0 }, { speed: 'fast' });
  assert.equal(pricing.round(std.usd), 5);
  assert.equal(pricing.round(fast.usd), 10);
});

test('costOf normalizes a dated model snapshot id to its alias', () => {
  assert.equal(pricing.normalizeModel('claude-opus-5-20260114'), 'claude-opus-5');
  assert.equal(pricing.costOf('claude-opus-5-20260114', { input: 1e6 }).priced, true);
});

test('an unknown model yields a null cost, never a guessed one', () => {
  const { usd, priced } = pricing.costOf('claude-something-9', { input: 1e6, output: 1e6 });
  assert.equal(usd, null);
  assert.equal(priced, false);
});

test('aggregate surfaces unpriced models instead of silently under-reporting', async () => {
  const root = tempRoot();
  const file = writeTranscript(root, '/tmp/j', 'cccccccc-0000-4000-8000-000000000003', [
    assistantLine({ msgId: 'm1', text: 'a', use: usage({ output_tokens: 100 }) }),
    assistantLine({ msgId: 'm2', text: 'b', model: 'claude-unreleased-7', use: usage({ output_tokens: 100 }) }),
  ]);
  const agg = await transcripts.aggregate(file);
  assert.deepEqual(agg.unpricedModels, ['claude-unreleased-7']);
  assert.equal(agg.complete, false, 'the total is known to be missing a model');
  assert.ok(agg.costUsd > 0, 'the models we can price still contribute');
  assert.equal(agg.byModel.find((m) => m.model === 'claude-unreleased-7').costUsd, null);
});

test('<synthetic> lines are unbilled, not unpriced', async () => {
  const root = tempRoot();
  const zero = usage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
  const file = writeTranscript(root, '/tmp/k', 'cccccccc-0000-4000-8000-000000000005', [
    assistantLine({ msgId: 'm1', text: 'interrupted', model: '<synthetic>', use: zero }),
  ]);
  const agg = await transcripts.aggregate(file);
  assert.deepEqual(agg.unpricedModels, [], 'a synthetic notice is not a pricing gap');
  assert.equal(agg.complete, true);
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
