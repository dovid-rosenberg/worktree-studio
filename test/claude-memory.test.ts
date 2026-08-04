// Sharing a repo's Claude Code memories with its worktrees.
//
// This is the only code in Studio that writes inside ~/.claude, so the tests lean hard
// on the refusal cases: the feature is a convenience, and no convenience is worth
// deleting a directory of memories the user accumulated over months.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { linkMemory, linkSessionMemory, memoryDirFor, projectDirName } from '../server/claude-memory.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wts-mem-'));
}

/** Give `repoPath` a memory directory holding one memory, as a real checkout has. */
function seedMemories(
  projects: string,
  repoPath: string,
  files: Record<string, string> = { 'a.md': 'remember' },
) {
  const dir = memoryDirFor(repoPath, projects);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

test("projectDirName mirrors Claude Code's encoding, dots included", () => {
  // The double hyphen is `/` followed by `.` — the shape every worktree path takes under
  // the default `.worktrees` layout, and the reason a naive slash-only replace is wrong.
  assert.equal(projectDirName('/Users/d/code/api/.worktrees/feat-x'), '-Users-d-code-api--worktrees-feat-x');
  assert.equal(
    projectDirName('/Users/d/Desktop/code/worktree-studio'),
    '-Users-d-Desktop-code-worktree-studio',
  );
});

test("a worktree with no memory directory gets a link to the checkout's", () => {
  const projects = tmp();
  const repo = '/code/api';
  const wt = '/code/api/.worktrees/feat-x';
  const target = seedMemories(projects, repo);

  const out = linkMemory(wt, repo, projects);
  assert.equal(out.status, 'linked');

  const link = memoryDirFor(wt, projects);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  // The point of the whole exercise: the worktree can now read the repo's memories.
  assert.equal(fs.readFileSync(path.join(link, 'a.md'), 'utf8'), 'remember');
  assert.equal(fs.realpathSync(link), fs.realpathSync(target));
});

test('a memory written from the worktree lands in the checkout, where the next one sees it', () => {
  const projects = tmp();
  const repo = '/code/api';
  seedMemories(projects, repo);
  linkMemory('/code/api/.worktrees/one', repo, projects);
  linkMemory('/code/api/.worktrees/two', repo, projects);

  fs.writeFileSync(path.join(memoryDirFor('/code/api/.worktrees/one', projects), 'learned.md'), 'from one');

  assert.equal(
    fs.readFileSync(path.join(memoryDirFor('/code/api/.worktrees/two', projects), 'learned.md'), 'utf8'),
    'from one',
    'worktrees of one repo share a single memory directory',
  );
  assert.ok(
    fs.existsSync(path.join(memoryDirFor(repo, projects), 'learned.md')),
    'and it outlives the worktree',
  );
});

test('linking twice is a no-op, not an error', () => {
  const projects = tmp();
  seedMemories(projects, '/code/api');
  assert.equal(linkMemory('/code/api/.worktrees/x', '/code/api', projects).status, 'linked');
  assert.equal(linkMemory('/code/api/.worktrees/x', '/code/api', projects).status, 'already');
});

test('a real memory directory with content is NEVER replaced', () => {
  const projects = tmp();
  seedMemories(projects, '/code/api');
  const wt = '/code/api/.worktrees/feat-x';
  // The worktree accumulated its own memories before linking existed.
  const own = memoryDirFor(wt, projects);
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'mine.md'), 'do not delete me');

  const out = linkMemory(wt, '/code/api', projects);
  assert.equal(out.status, 'occupied');
  assert.equal(fs.readFileSync(path.join(own, 'mine.md'), 'utf8'), 'do not delete me');
  assert.ok(!fs.lstatSync(own).isSymbolicLink(), 'the real directory survives untouched');
});

test('an EMPTY memory directory is replaced — there is nothing to lose', () => {
  const projects = tmp();
  seedMemories(projects, '/code/api');
  const wt = '/code/api/.worktrees/feat-x';
  fs.mkdirSync(memoryDirFor(wt, projects), { recursive: true });

  assert.equal(linkMemory(wt, '/code/api', projects).status, 'linked');
  assert.ok(fs.lstatSync(memoryDirFor(wt, projects)).isSymbolicLink());
});

test('a link someone else pointed elsewhere is left alone', () => {
  const projects = tmp();
  seedMemories(projects, '/code/api');
  const elsewhere = seedMemories(projects, '/code/other', { 'b.md': 'other' });
  const wt = '/code/api/.worktrees/feat-x';
  const link = memoryDirFor(wt, projects);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(elsewhere, link, 'dir');

  const out = linkMemory(wt, '/code/api', projects);
  assert.equal(out.status, 'occupied');
  assert.equal(fs.realpathSync(link), fs.realpathSync(elsewhere), 'the deliberate choice stands');
});

test('a checkout with no memories yet is skipped rather than seeded', () => {
  const projects = tmp();
  const out = linkMemory('/code/api/.worktrees/x', '/code/api', projects);
  assert.equal(out.status, 'skipped');
  // No empty scaffolding left behind for a repo that has never used memory.
  assert.ok(!fs.existsSync(memoryDirFor('/code/api/.worktrees/x', projects)));
});

test('a session running in the checkout itself is skipped', () => {
  const projects = tmp();
  seedMemories(projects, '/code/api');
  const out = linkMemory('/code/api', '/code/api', projects);
  assert.equal(out.status, 'skipped');
  // It already IS the real directory; linking it to itself would be a loop.
  assert.ok(!fs.lstatSync(memoryDirFor('/code/api', projects)).isSymbolicLink());
});

test('each repo of a multi-repo session links to its OWN memories', () => {
  const projects = tmp();
  seedMemories(projects, '/code/api', { 'api.md': 'backend rules' });
  seedMemories(projects, '/code/fe', { 'fe.md': 'frontend rules' });

  const results = linkSessionMemory(
    [
      { repo: 'api', repoPath: '/code/api', worktreePath: '/code/api/.worktrees/feat' },
      { repo: 'fe', repoPath: '/code/fe', worktreePath: '/code/fe/.worktrees/feat' },
    ],
    projects,
  );

  assert.deepEqual(
    results.map((r) => r.outcome.status),
    ['linked', 'linked'],
  );
  // Crossing them would be worse than doing nothing: the FE worktree would read the
  // backend's conventions.
  assert.ok(fs.existsSync(path.join(memoryDirFor('/code/api/.worktrees/feat', projects), 'api.md')));
  assert.ok(fs.existsSync(path.join(memoryDirFor('/code/fe/.worktrees/feat', projects), 'fe.md')));
  assert.ok(!fs.existsSync(path.join(memoryDirFor('/code/fe/.worktrees/feat', projects), 'api.md')));
});

test('a session with no promoted worktree links nothing', () => {
  const projects = tmp();
  seedMemories(projects, '/code/api');
  const results = linkSessionMemory([{ repo: 'api', repoPath: '/code/api', worktreePath: null }], projects);
  assert.deepEqual(results, [], 'nothing to link before promote');
});
