/*
 * UPDATE FROM BASE (server/git.ts's updateFromBase + POST /group/update), against REAL
 * git repos.
 *
 * A fake git would prove only that the branching in the route is wired up. Everything
 * worth testing here is a property of the working tree afterwards: that a refusal left
 * the head exactly where it was, that a failed rebase is not still in progress, that a
 * dirty worktree's uncommitted work is still uncommitted. So these build actual repos,
 * move the base underneath a worktree, and assert on git's own answers.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';
import * as orchestrator from '../server/orchestrator.ts';
import { updateFromBase } from '../server/git.ts';
import { body as jsonBody } from './helpers.ts';
import type { JsonBody } from './helpers.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } }).trim();

const head = (cwd: string) => git(cwd, 'rev-parse', 'HEAD');

/** A repo on `main` with one commit per named file. */
function repo(prefix = 'wts-update-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'shared.js'), 'base\n');
  fs.writeFileSync(path.join(dir, 'mine.js'), 'base\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** A worktree on its own branch with one commit, and `main` moved on underneath it. */
function behindWorktree(
  dir: string,
  name: string,
  { branchFile = 'mine.js', baseFile = 'shared.js' } = {},
): string {
  const wt = path.join(dir, '.worktrees', name);
  git(dir, 'worktree', 'add', '-q', '-b', `feature/${name}`, wt);
  fs.writeFileSync(path.join(wt, branchFile), 'branch work\n');
  git(wt, 'commit', '-qam', 'branch work');
  // main moves on AFTER the branch is cut — this is what "behind" means.
  fs.writeFileSync(path.join(dir, baseFile), 'moved on\n');
  git(dir, 'commit', '-qam', 'base moves on');
  return wt;
}

test('a clean worktree behind its base is rebased onto it', async () => {
  const dir = repo();
  const wt = behindWorktree(dir, 'clean');
  const before = head(wt);

  const r = await updateFromBase(wt, 'main');

  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.updated, true);
  assert.equal(r.behind, 1, 'reports how far behind it was');
  assert.equal(git(wt, 'rev-list', '--count', 'HEAD..main'), '0', 'no longer behind');
  assert.notEqual(head(wt), before, 'the commit was replayed, so it has a new sha');
  assert.equal(git(wt, 'log', '-1', '--format=%s'), 'branch work', 'and it is still the branch commit');
  // The base's commit is now an ancestor — a REBASE, not a merge: the branch is still one
  // straight line, which is how every branch in this repo is shaped.
  assert.equal(git(wt, 'rev-list', '--count', '--merges', 'main..HEAD'), '0', 'no merge commit');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an already-current worktree is a no-op success', async () => {
  const dir = repo();
  const wt = path.join(dir, '.worktrees', 'current');
  git(dir, 'worktree', 'add', '-q', '-b', 'feature/current', wt);
  const before = head(wt);

  const r = await updateFromBase(wt, 'main');

  assert.deepEqual(
    { ok: r.ok, updated: r.updated, behind: r.behind },
    { ok: true, updated: false, behind: 0 },
  );
  assert.equal(head(wt), before, 'nothing was rewritten');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dirty worktree is refused, and its uncommitted work is untouched', async () => {
  const dir = repo();
  const wt = behindWorktree(dir, 'dirty');
  fs.writeFileSync(path.join(wt, 'mine.js'), 'work in progress\n');
  const before = head(wt);

  const r = await updateFromBase(wt, 'main');

  assert.equal(r.ok, false);
  assert.match(r.error || '', /uncommitted change/);
  assert.match(r.error || '', /mine\.js/, 'names what is dirty');
  assert.equal(head(wt), before, 'the head did not move');
  assert.equal(
    fs.readFileSync(path.join(wt, 'mine.js'), 'utf8'),
    'work in progress\n',
    'the uncommitted work is neither stashed nor replayed — the refusal means what it says',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an untracked file is not "dirty" — a rebase carries it through', async () => {
  const dir = repo();
  const wt = behindWorktree(dir, 'untracked');
  fs.writeFileSync(path.join(wt, 'npm-debug.log'), 'noise\n');

  const r = await updateFromBase(wt, 'main');

  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.updated, true);
  assert.ok(fs.existsSync(path.join(wt, 'npm-debug.log')), 'and it is still there');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a worktree whose files the base has also changed is refused BEFORE the rebase starts', async () => {
  const dir = repo();
  // Both sides edit shared.js: the drift read predicts the fight, so nothing is attempted.
  const wt = behindWorktree(dir, 'conflict', { branchFile: 'shared.js', baseFile: 'shared.js' });
  const before = head(wt);

  const r = await updateFromBase(wt, 'main');

  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts, ['shared.js']);
  assert.match(r.error || '', /would conflict/);
  assert.equal(head(wt), before, 'the head did not move');
  assert.equal(git(wt, 'status', '--porcelain'), '', 'no conflict markers were written');
  // The one that matters: a verb that leaves four repos mid-rebase is worse than no verb.
  const rebaseDir = git(wt, 'rev-parse', '--git-path', 'rebase-merge');
  assert.equal(fs.existsSync(path.resolve(wt, rebaseDir)), false, 'no rebase was started');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a detached worktree is refused', async () => {
  const dir = repo();
  const wt = path.join(dir, '.worktrees', 'detached');
  git(dir, 'worktree', 'add', '-q', '--detach', wt);

  const r = await updateFromBase(wt, 'main');

  assert.equal(r.ok, false);
  assert.match(r.error || '', /detached/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rebase already in progress is refused rather than resumed', async () => {
  const dir = repo();
  const wt = behindWorktree(dir, 'midway', { branchFile: 'shared.js', baseFile: 'shared.js' });
  // Start the conflicting rebase by hand and leave it stopped — the state a user lands in
  // when they rebase in a terminal, get a conflict, and come back to Studio.
  try {
    git(wt, 'rebase', 'main');
  } catch {
    /* expected: it stops on the conflict */
  }

  const r = await updateFromBase(wt, 'main');

  assert.equal(r.ok, false);
  assert.match(r.error || '', /already in progress/);
  git(wt, 'rebase', '--abort');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// POST /group/update — a feature is several repos, and they can disagree
// ---------------------------------------------------------------------------

interface Member {
  repo: string;
  path: string;
  branch?: string | null;
  running?: boolean;
  ports?: number[];
}

/** The orchestrator, wired to real repos and fakes for everything that is not git. */
function harness(members: Member[], repoPaths: Array<{ name: string; path: string }>) {
  const calls = { stopped: [] as string[], rescans: 0 };
  const app = express();
  app.use(express.json());
  const api = express.Router();
  app.use('/api/v1', api);
  orchestrator.register(api, {
    cfg: { editors: {}, defaultEditor: '' },
    servers: {
      featureFor: (p: string) => p,
      allocSlotFor: () => ({ slot: 0 }),
      releaseSlotIfIdle: () => true,
      releaseSlot: () => {},
      launchOpts: () => ({}),
      startAll: async () => ({ ok: true as const, results: [] }),
      stop: async (repo: string) => {
        calls.stopped.push(repo);
        return { ok: true as const, killed: true, stillListening: [] };
      },
      restart: async () => ({ ok: true }),
    },
    manager: {
      deactivate: async () => ({}),
      close: async () => ({}),
      sessionForWorktree: () => null,
      adopt: async () => null,
      attachRepo: async () => ({}),
    },
    repos: () => repoPaths,
    resolveGroup: async (name: string) =>
      name === 'feat' ? { group: { members }, flat: members } : { group: null, flat: [] },
    conflictsFor: () => [],
    refreshRunning: async () => {},
    running: () => new Map(),
    scheduleBroadcast: () => {},
    rescan: async () => {
      calls.rescans++;
    },
  });
  return { app, calls };
}

async function post(app: express.Express, body: unknown): Promise<{ status: number; json: JsonBody }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/group/update`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return { status: res.status, json: await jsonBody(res) };
  } finally {
    server.close();
  }
}

test('/group/update reports per member: one repo rebases, the other refuses', async () => {
  const clean = repo('wts-update-be-');
  const dirty = repo('wts-update-fe-');
  const cleanWt = behindWorktree(clean, 'feat');
  const dirtyWt = behindWorktree(dirty, 'feat');
  fs.writeFileSync(path.join(dirtyWt, 'mine.js'), 'half-finished\n');

  const { app, calls } = harness(
    [
      { repo: 'be', path: cleanWt, branch: 'feature/feat' },
      { repo: 'fe', path: dirtyWt, branch: 'feature/feat' },
    ],
    [
      { name: 'be', path: clean },
      { name: 'fe', path: dirty },
    ],
  );
  const { json } = await post(app, { group: 'feat' });

  assert.equal(json.ok, false, 'one repo refusing is not a successful update');
  assert.equal(json.updated, 1);
  assert.equal(json.total, 2);
  const [be, fe] = json.results;
  assert.deepEqual(
    { repo: be.repo, ok: be.ok, updated: be.updated },
    { repo: 'be', ok: true, updated: true },
  );
  assert.equal(fe.repo, 'fe');
  assert.equal(fe.ok, false);
  assert.match(fe.error, /uncommitted change/);
  // The base each repo was measured against is reported, because it is resolved from the
  // repo rather than taken from the request.
  assert.equal(be.base, 'main');
  assert.equal(git(cleanWt, 'rev-list', '--count', 'HEAD..main'), '0');
  assert.equal(calls.rescans, 1, 'the heads moved, so the scan is stale');
  for (const d of [clean, dirty]) fs.rmSync(d, { recursive: true, force: true });
});

test('/group/update will not rebase under a running dev server without being told to', async () => {
  const dir = repo('wts-update-live-');
  const wt = behindWorktree(dir, 'feat');
  const before = head(wt);
  const members = [{ repo: 'be', path: wt, branch: 'feature/feat', running: true, ports: [3000] }];
  const repos = [{ name: 'be', path: dir }];

  const first = await post(harness(members, repos).app, { group: 'feat' });
  assert.equal(first.json.needsConfirm, true, 'a bundler watching a tree being replayed is the hazard');
  assert.deepEqual(
    first.json.running.map((m: { repo: string }) => m.repo),
    ['be'],
  );
  assert.equal(head(wt), before, 'and nothing was rebased while it asked');

  const { app, calls } = harness(members, repos);
  const second = await post(app, { group: 'feat', stopServers: true });
  assert.equal(second.json.ok, true, JSON.stringify(second.json.results));
  assert.deepEqual(calls.stopped, ['be'], 'the server is stopped first');
  assert.deepEqual(second.json.stopped, ['be'], 'and the caller is told, so ▶ is the next press');
  assert.equal(git(wt, 'rev-list', '--count', 'HEAD..main'), '0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('/group/update answers 404 for a feature that does not exist', async () => {
  const { app } = harness([], []);
  const r = await post(app, { group: 'nope' });
  assert.equal(r.status, 404);
});
