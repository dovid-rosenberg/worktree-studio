/*
 * Finding a closed session's conversation, and knowing when it can actually come back.
 *
 * Two facts shape this: `--resume` finds a conversation by slugging the CURRENT WORKING
 * DIRECTORY (so a missing worktree cannot be resumed where it lies), and the slug is
 * LOSSY — every non-alphanumeric becomes '-', so `foo/bar`, `foo.bar` and `foo-bar`
 * collide. You can only go forwards, from a path you already know.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { conversationFor, findOrphans } from '../server/reinstate.ts';
import { projectDirName } from '../server/claude-memory.ts';

/** A fake ~/.claude/projects with a conversation for `worktreePath`. */
function projects(): { dir: string; add: (wt: string, ids: string[]) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-proj-'));
  return {
    dir,
    add(wt, ids) {
      const d = path.join(dir, projectDirName(wt));
      fs.mkdirSync(d, { recursive: true });
      for (const [i, id] of ids.entries()) {
        fs.writeFileSync(path.join(d, `${id}.jsonl`), '{}\n');
        // Distinct mtimes, oldest first, so "newest" is a real choice and not luck.
        const t = Date.now() / 1000 - (ids.length - i) * 60;
        fs.utimesSync(path.join(d, `${id}.jsonl`), t, t);
      }
    },
  };
}

test('the conversation id is the FILENAME — which is the whole recovery mechanism', () => {
  // Studio's own claudeSessionId is deleted with the session record, so the only
  // surviving copy of the id is what Claude named the file.
  const p = projects();
  p.add('/code/api/.worktrees/alpha', ['abc-123']);
  assert.equal(conversationFor('/code/api/.worktrees/alpha', p.dir)?.id, 'abc-123');
  fs.rmSync(p.dir, { recursive: true, force: true });
});

test('several conversations in one worktree → the NEWEST, and it says how many', () => {
  const p = projects();
  p.add('/code/api/.worktrees/alpha', ['old-1', 'old-2', 'newest-3']);
  const c = conversationFor('/code/api/.worktrees/alpha', p.dir);
  assert.equal(c?.id, 'newest-3', 'closed and restarted here — the last one is "this work"');
  assert.equal(c?.count, 3);
  fs.rmSync(p.dir, { recursive: true, force: true });
});

test('a transcript directory with no conversation is not an orphan', () => {
  // Some worktrees have only a shared `memory` dir and never held a conversation.
  const p = projects();
  fs.mkdirSync(path.join(p.dir, projectDirName('/code/api/.worktrees/bare'), 'memory'), { recursive: true });
  assert.equal(conversationFor('/code/api/.worktrees/bare', p.dir), null);
  fs.rmSync(p.dir, { recursive: true, force: true });
});

test('a worktree still ON DISK is recoverable whatever its branch says', () => {
  const p = projects();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-live-'));
  p.add(wt, ['live-1']);
  const [o] = findOrphans(
    [{ worktreePath: wt, repo: 'api', name: 'alpha', branch: 'feature/a', branchExists: false }],
    p.dir,
  );
  assert.equal(o.recoverable, true, 'nothing needs recreating');
  fs.rmSync(wt, { recursive: true, force: true });
  fs.rmSync(p.dir, { recursive: true, force: true });
});

test('a MISSING worktree whose BRANCH survives is recoverable — the case worth building', () => {
  const p = projects();
  p.add('/code/api/.worktrees/gone', ['conv-1']);
  const [o] = findOrphans(
    [
      {
        worktreePath: '/code/api/.worktrees/gone',
        repo: 'api',
        name: 'gone',
        branch: 'fix/x',
        branchExists: true,
      },
    ],
    p.dir,
  );
  assert.equal(o.recoverable, true);
  assert.equal(o.claudeSessionId, 'conv-1');
  assert.equal(o.reason, undefined, 'nothing to explain');
  fs.rmSync(p.dir, { recursive: true, force: true });
});

test('a missing worktree with NO branch is refused, and says why', () => {
  /*
   * Recreating here would give an empty branch off the default with a transcript attached
   * — an agent resuming into a directory that does not contain the code it is discussing.
   * Refusing is better than faking it.
   */
  const p = projects();
  p.add('/code/api/.worktrees/lost', ['conv-2']);
  const [o] = findOrphans(
    [
      {
        worktreePath: '/code/api/.worktrees/lost',
        repo: 'api',
        name: 'lost',
        branch: 'fix/y',
        branchExists: false,
      },
    ],
    p.dir,
  );
  assert.equal(o.recoverable, false);
  assert.match(o.reason || '', /both gone/);
  assert.match(o.reason || '', /still readable/, 'and points at what CAN be done');
  fs.rmSync(p.dir, { recursive: true, force: true });
});

test('orphans come back newest first', () => {
  const p = projects();
  p.add('/code/api/.worktrees/older', ['a']);
  p.add('/code/api/.worktrees/newer', ['b']);
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(p.dir, projectDirName('/code/api/.worktrees/newer'), 'b.jsonl'), now, now);

  const out = findOrphans(
    [
      {
        worktreePath: '/code/api/.worktrees/older',
        repo: 'api',
        name: 'older',
        branch: 'x',
        branchExists: true,
      },
      {
        worktreePath: '/code/api/.worktrees/newer',
        repo: 'api',
        name: 'newer',
        branch: 'y',
        branchExists: true,
      },
    ],
    p.dir,
  );
  assert.deepEqual(
    out.map((o) => o.name),
    ['newer', 'older'],
  );
  fs.rmSync(p.dir, { recursive: true, force: true });
});

test('the slug is lossy, which is why lookup only goes forwards', () => {
  // `foo-bar`, `foo/bar` and `foo.bar` all collide. Any implementation that tried to walk
  // a transcript directory BACK to a worktree path would guess wrong.
  assert.equal(projectDirName('/a/foo-bar'), projectDirName('/a/foo/bar'));
  assert.equal(projectDirName('/a/foo.bar'), projectDirName('/a/foo-bar'));
});
