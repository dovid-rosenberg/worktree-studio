// The external calls that can hang, and the ceilings on them.
//
// A hang is not a slow call, so it is driven with a real child that never exits:
// a fake `git` first on PATH. What is asserted is that the parent stops waiting
// AND that the child is actually gone — a promise-level race would satisfy the
// first and leave the process wedged forever, which is the whole reason the bound
// has to be execFile's own `timeout`.
import { test } from 'node:test';
import assert from 'node:assert';
import { expectOk } from './helpers.ts';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { run, DEFAULT_TIMEOUT_MS } from '../server/util.ts';
import { pushBranchToOrigin, pushFailureLine, createForge, TIMEOUTS } from '../server/forge.ts';
import * as worktree from '../server/worktree.ts';

const REAL_GIT = execFileSync('/usr/bin/which', ['git']).toString().trim();

// A directory holding a `git` that sleeps forever — on every subcommand, or only
// on the one named. Everything else is handed to the real git.
function fakeGitBin(dir: string, onlyFor?: string) {
  const bin = path.join(dir, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const guard = onlyFor
    ? `for a in "$@"; do if [ "$a" = ${onlyFor} ]; then exec sleep 300; fi; done\nexec ${REAL_GIT} "$@"\n`
    : 'exec sleep 300\n';
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n${guard}`, { mode: 0o755 });
  return bin;
}

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-timeout-'));
  const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: dir, stdio: 'ignore' });
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 't@t.t']);
  sh('git', ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\nfakebin/\n');
  sh('git', ['add', '.gitignore']);
  sh('git', ['commit', '-qm', 'init']);
  return dir;
}

// ---------------------------------------------------------------------------
// util.run
// ---------------------------------------------------------------------------

test('run() kills a child that never exits, and says that is what happened', async () => {
  const marker = `wts-timeout-marker-${process.pid}`;
  const t0 = Date.now();
  const r = await run('/bin/sh', ['-c', `sleep 300 # ${marker}`], { timeout: 300 });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `run() waited ${ms}ms on a child it was told to bound`);
  assert.equal(r.timedOut, true, 'the caller can tell a hang from any other failure');
  assert.notEqual(r.code, 0);
  // The point of using execFile's own timeout: the process is REAPED, not just
  // abandoned by a promise that resolved without it.
  await new Promise((res) => setTimeout(res, 200));
  let survivors = '';
  try {
    survivors = execFileSync('/usr/bin/pgrep', ['-f', marker]).toString().trim();
  } catch {
    /* none — pgrep exits 1 */
  }
  assert.equal(survivors, '', `the child survived the timeout: ${survivors}`);
});

test('run() applies a finite default ceiling when the caller names none', () => {
  assert.ok(
    Number.isFinite(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS > 0,
    'every child process has a backstop, not just the ones a caller thought about',
  );
});

// ---------------------------------------------------------------------------
// git fetch, in worktree.create
// ---------------------------------------------------------------------------

test('create() survives a `git fetch` that never answers', async () => {
  const repo = tempRepo();
  const bin = fakeGitBin(repo, 'fetch');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const t0 = Date.now();
    const res = await worktree.create(repo, 'feature/hang', 'hang', {
      fetchTimeoutMs: 400,
      copyPatterns: [],
      copyAlways: [],
    });
    const ms = Date.now() - t0;
    assert.ok(
      fs.existsSync(expectOk(res, 'create()').path),
      'the worktree is still created from the refs already local',
    );
    assert.ok(ms < 10000, `create() took ${ms}ms — the fetch is unbounded`);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('create() bounds the fetch even when the caller names no timeout', () => {
  assert.ok(Number.isFinite(worktree.FETCH_TIMEOUT_MS) && worktree.FETCH_TIMEOUT_MS > 0);
});

// ---------------------------------------------------------------------------
// git push / gh pr create, in forge
// ---------------------------------------------------------------------------

test('pushBranchToOrigin() gives up on a push that never answers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-push-'));
  const bin = fakeGitBin(dir);
  try {
    const t0 = Date.now();
    const r = await pushBranchToOrigin(
      { repo: 'api', path: dir, branch: 'b' },
      { PATH: `${bin}:${process.env.PATH}` },
      400,
    );
    const ms = Date.now() - t0;
    assert.ok(ms < 10000, `the push was awaited for ${ms}ms`);
    assert.equal(r.timedOut, true);
    assert.notEqual(r.code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a timed-out push is reported as one, not as "git push exited 1"', () => {
  assert.match(pushFailureLine({ timedOut: true, code: 1, stdout: '', stderr: '' }), /timed out/i);
  // …and an ordinary failure still reads exactly as before.
  assert.equal(
    pushFailureLine({
      code: 1,
      stdout: 'To github.com:acme/api.git\n',
      stderr: '! [rejected] main -> main\n',
    }),
    '! [rejected] main -> main',
  );
});

test('openPullRequest surfaces a hung push instead of blaming the forge CLI', async () => {
  const f = createForge({
    providers: [
      {
        id: 'gh',
        cli: 'gh',
        // This double never lists reviews; the interface requires the member.
        reviews: async () => [],
        view: async () => null,
        create: async () => {
          throw new Error('must not be reached');
        },
      },
    ],
    isInstalled: () => true,
    pushBranch: async () => ({ code: 1, timedOut: true, stdout: '', stderr: '' }),
  });
  const out = await f.openPullRequest({ repo: 'api', path: '/x', branch: 'b' }, {});
  assert.match(String(out.error), /timed out/i);
});

test('every forge call out to the network is bounded', () => {
  for (const [name, ms] of Object.entries(TIMEOUTS)) {
    assert.ok(Number.isFinite(ms) && ms > 0, `${name} is not a finite ceiling`);
  }
});
