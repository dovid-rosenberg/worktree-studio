import { test } from 'node:test';
import assert from 'node:assert';
import { present } from './helpers.ts';
import { deriveBranch, seedPrompt } from '../server/sessions.ts';
import * as status from '../server/status.ts';
import * as git from '../server/git.ts';

test('deriveBranch picks fix/ for bug-ish titles and feature/ otherwise', () => {
  // numeric source id becomes the branch prefix; no bug keyword → feature/
  assert.equal(
    deriveBranch({ title: 'Invoice API order_by ignores values', body: '', id: '487' }),
    'feature/487-invoice-api-order-by-ignores-values',
  );
  assert.equal(
    deriveBranch({ title: 'Add cash transactions', body: '', id: null }),
    'feature/add-cash-transactions',
  );
  assert.match(deriveBranch({ title: 'Fix broken refund', body: '', id: null }), /^fix\//);
  assert.match(deriveBranch({ title: 'Feature', body: 'this is a bug', id: null }), /^fix\//);
});

test('seedPrompt: freetext is the raw text; issues include title+body+url', () => {
  // freetext → exactly what the user typed (no wrapper, no duplication)
  assert.equal(
    seedPrompt({ source: 'freetext', title: 'Find the DAF', body: 'Find the different DAF card types' }),
    'Find the different DAF card types',
  );
  // issue source → title + body + link, but no boilerplate
  const p = seedPrompt({ source: 'github', title: 'T', body: 'B', url: 'http://x/1' });
  assert.match(p, /T/);
  assert.match(p, /B/);
  assert.match(p, /http:\/\/x\/1/);
  assert.doesNotMatch(p, /promote it to a worktree/);
});

test('status.mapEvent maps lifecycle events to states', () => {
  assert.equal(present(status.mapEvent('Notification', {})).state, 'waiting');
  assert.equal(present(status.mapEvent('PreToolUse', { tool_name: 'Bash' })).state, 'working');
  assert.match(present(status.mapEvent('PreToolUse', { tool_name: 'Bash' })).activity, /Bash/);
  assert.equal(present(status.mapEvent('Stop', {})).state, 'idle');
  assert.equal(present(status.mapEvent('SessionEnd', {})).state, 'stopped');
  assert.equal(status.mapEvent('Nonsense', {}), null);
});

test('status.buildSettings wires all lifecycle hooks to the studio port', () => {
  const s = status.buildSettings('s_abc', 7788);
  for (const ev of ['SessionStart', 'Notification', 'Stop', 'PreToolUse']) {
    assert.ok(s.hooks[ev], `${ev} present`);
    assert.match(s.hooks[ev][0].hooks[0].command, /wts=s_abc/);
    assert.match(s.hooks[ev][0].hooks[0].command, /7788/);
  }
});

test('git.parseWorktrees parses porcelain output', () => {
  const out = git.parseWorktrees(
    [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repo/.worktrees/foo',
      'HEAD def',
      'branch refs/heads/feature/foo',
      '',
    ].join('\n'),
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].branch, 'main');
  assert.equal(out[1].branch, 'feature/foo');
  assert.equal(out[1].path, '/repo/.worktrees/foo');
});
