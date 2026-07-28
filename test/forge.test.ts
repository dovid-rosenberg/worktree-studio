// The forge boundary (server/forge.ts): the check-tally tables that drive the CI
// pill, and the provider contract — GitHub first, GitLab as the fallback, cached,
// and never throwing out of a lookup. Providers are injected, so no gh/glab and no
// network are involved.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createForge, ghChecks, glChecks, PROVIDERS, pushFailureLine } from '../server/forge.ts';
import type { Provider, PushResult } from '../server/forge.ts';
import type { AddressInfo } from 'net';
import type { Router } from 'express';
import { body as jsonBody, present } from './helpers.ts';
import type { JsonBody } from './helpers.ts';

// A worktree path that is deliberately NOT a git repo — used to drive the real
// `git push` failure path end to end.
const NOT_A_REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-forge-'));

// A stand-in provider whose view/create are scripted per call.
function provider(id: string, { view, create }: Partial<Pick<Provider, 'view' | 'create'>> = {}): Provider {
  return {
    id,
    cli: id,
    view: view ?? (async () => null),
    create: create ?? (async () => ({ ok: false, stderr: '' })),
  };
}

// openPullRequest pushes before it creates, and a failed push now short-circuits.
// Tests about the PROVIDER contract inject a push that succeeded, so they exercise
// the half they are about; the push half has its own tests below (including one
// that uses the real git).
const OK_PUSH = async (): Promise<PushResult> => ({ code: 0, stdout: '', stderr: '' });

function forge(providers: Provider[]) {
  return createForge({ providers, isInstalled: () => true, pushBranch: OK_PUSH });
}

// ---------------------------------------------------------------------------
// check tallies
// ---------------------------------------------------------------------------

test('ghChecks tallies a mixed CheckRun / StatusContext rollup', () => {
  assert.deepEqual(ghChecks([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'COMPLETED', conclusion: 'FAILURE' },
    { status: 'IN_PROGRESS' },
    { state: 'PENDING' },        // StatusContext node — state, not status
    { state: 'SUCCESS' },
    { status: 'COMPLETED', conclusion: 'SKIPPED' }, // counts toward total only
  ]), { passed: 2, running: 2, failed: 1, total: 6 });
});

test('ghChecks treats a missing or non-array rollup as no checks', () => {
  assert.deepEqual(ghChecks(undefined), { passed: 0, running: 0, failed: 0, total: 0 });
  assert.deepEqual(ghChecks(null), { passed: 0, running: 0, failed: 0, total: 0 });
});

test('glChecks maps one pipeline status onto the same shape', () => {
  assert.deepEqual(glChecks('success'), { passed: 1, running: 0, failed: 0, total: 1 });
  assert.deepEqual(glChecks('FAILED'), { passed: 0, running: 0, failed: 1, total: 1 });
  assert.deepEqual(glChecks('pending'), { passed: 0, running: 1, failed: 0, total: 1 });
  assert.deepEqual(glChecks(''), { passed: 0, running: 0, failed: 0, total: 0 }, 'no pipeline at all');
  assert.deepEqual(glChecks('manual'), { passed: 0, running: 0, failed: 0, total: 0 }, 'unknown status is not guessed at');
});

// ---------------------------------------------------------------------------
// ciForRepo — provider order, caching, failure containment
// ---------------------------------------------------------------------------

const ENTRY = { repo: 'api', worktreePath: '/wt/feat-a', branch: 'feature/a' };
const GH_HIT = { hasPR: true, provider: 'github', number: 1, url: 'https://gh/1', state: 'OPEN', checks: ghChecks([]) };
const GL_HIT = { hasPR: true, provider: 'gitlab', number: 9, url: 'https://gl/9', state: 'opened', checks: glChecks('success') };

test('ciForRepo answers from the first provider that has a PR and never asks the second', async () => {
  let gitlabAsked = false;
  const f = forge([
    provider('github', { view: async () => GH_HIT }),
    provider('gitlab', { view: async () => { gitlabAsked = true; return GL_HIT; } }),
  ]);
  assert.deepEqual(await f.ciForRepo(ENTRY, {}), { repo: 'api', ...GH_HIT });
  assert.equal(gitlabAsked, false, 'GitHub wins; GitLab is only a fallback');
});

test('ciForRepo falls back to the next provider when the first has no PR', async () => {
  const f = forge([provider('github'), provider('gitlab', { view: async () => GL_HIT })]);
  assert.deepEqual(await f.ciForRepo(ENTRY, {}), { repo: 'api', ...GL_HIT });
});

test('ciForRepo reports no PR when no provider finds one', async () => {
  const f = forge([provider('github'), provider('gitlab')]);
  assert.deepEqual(await f.ciForRepo(ENTRY, {}), { repo: 'api', hasPR: false });
});

test('ciForRepo swallows a provider throwing (bad JSON, CLI blowing up)', async () => {
  const f = forge([provider('github', { view: async () => { throw new Error('unexpected token'); } })]);
  assert.deepEqual(await f.ciForRepo(ENTRY, {}), { repo: 'api', hasPR: false }, 'a lookup must never reject');
});

test('ciForRepo caches per worktreePath+branch and re-serves the cached answer', async () => {
  let calls = 0;
  const f = forge([provider('github', { view: async () => { calls++; return GH_HIT; } })]);
  await f.ciForRepo(ENTRY, {});
  await f.ciForRepo(ENTRY, {});
  assert.equal(calls, 1, 'UI polling does not re-shell out inside the TTL');
  await f.ciForRepo({ ...ENTRY, branch: 'feature/b' }, {});
  assert.equal(calls, 2, 'a different branch is a different cache key');
  await f.ciForRepo({ ...ENTRY, repo: 'fe' }, {});
  assert.equal(calls, 2, 'the repo name is not part of the key — it is stamped onto the answer');
});

test('invalidate() drops the cache so a triggered refresh really re-looks', async () => {
  // The push side calls this when it knows the truth changed (a commit, a push, a PR
  // just opened). Without it a refresh fired inside the TTL would re-serve exactly
  // the answer it was fired to replace.
  let calls = 0;
  const f = forge([provider('github', { view: async () => { calls++; return GH_HIT; } })]);
  await f.ciForRepo(ENTRY, {});
  await f.ciForRepo(ENTRY, {});
  assert.equal(calls, 1);
  f.invalidate();
  await f.ciForRepo(ENTRY, {});
  assert.equal(calls, 2, 'the cached answer is wrong now, not merely old');
});

test('ciForRepo short-circuits an entry with no worktree or no branch', async () => {
  let asked = false;
  const f = forge([provider('github', { view: async () => { asked = true; return GH_HIT; } })]);
  assert.deepEqual(await f.ciForRepo({ repo: 'api', worktreePath: null, branch: 'b' }, {}), { repo: 'api', hasPR: false });
  assert.deepEqual(await f.ciForRepo({ repo: 'api', worktreePath: '/wt', branch: null }, {}), { repo: 'api', hasPR: false });
  assert.equal(asked, false, 'an unpromoted repo never reaches a CLI');
});

test('an uninstalled CLI is never consulted', async () => {
  let asked = false;
  const f = createForge({
    providers: [provider('github', { view: async () => { asked = true; return GH_HIT; } })],
    isInstalled: () => false,
  });
  assert.deepEqual(f.installed, []);
  assert.deepEqual(await f.ciForRepo(ENTRY, {}), { repo: 'api', hasPR: false });
  assert.equal(asked, false);
});

// ---------------------------------------------------------------------------
// openPullRequest — push first, then provider order, then failure attribution
// ---------------------------------------------------------------------------

const MEMBER = { repo: 'api', path: NOT_A_REPO, branch: 'feature/a' };

test('openPullRequest returns the first provider that opens one', async () => {
  let gitlabAsked = false;
  const f = forge([
    provider('github', { create: async () => ({ ok: true, url: 'https://gh/pr/1' }) }),
    provider('gitlab', { create: async () => { gitlabAsked = true; return { ok: true, url: 'x' }; } }),
  ]);
  assert.deepEqual(await f.openPullRequest(MEMBER, {}), { repo: 'api', url: 'https://gh/pr/1' });
  assert.equal(gitlabAsked, false);
});

test('openPullRequest falls back to the next provider when the first refuses', async () => {
  const f = forge([
    provider('github', { create: async () => ({ ok: false, stderr: 'gh: no such remote' }) }),
    provider('gitlab', { create: async () => ({ ok: true, url: 'https://gl/mr/9' }) }),
  ]);
  assert.deepEqual(await f.openPullRequest(MEMBER, {}), { repo: 'api', url: 'https://gl/mr/9' });
});

test('openPullRequest reports the FIRST installed provider\'s first stderr line when all refuse', async () => {
  // Both CLIs are present, so both genuinely ran and refused. GitHub is tried
  // first and is the forge the repo is on — its reason is the one to show.
  const f = forge([
    provider('github', { create: async () => ({ ok: false, stderr: 'gh: pull request already exists\nmore gh noise' }) }),
    provider('gitlab', { create: async () => ({ ok: false, stderr: '  glab: not authenticated\ntrace\n' }) }),
  ]);
  assert.deepEqual(await f.openPullRequest(MEMBER, {}), { repo: 'api', error: 'gh: pull request already exists' });
});

// The bug this asserts against: on a GitHub-only repo `gh pr create` fails with a
// real reason, then glab's spawn fails with ENOENT and leaves stderr empty — and
// reporting the LAST provider's stderr let that emptiness erase gh's reason.
test('an uninstalled provider\'s silence never overwrites the reason from one that ran', async () => {
  const f = createForge({
    providers: [
      provider('github', { create: async () => ({ ok: false, stderr: 'gh: No commits between main and feature/a' }) }),
      provider('gitlab', { create: async () => ({ ok: false, stderr: '' }) }), // ENOENT — never ran
    ],
    isInstalled: (p) => p.id === 'github',
    pushBranch: OK_PUSH,
  });
  assert.deepEqual(await f.openPullRequest(MEMBER, {}), { repo: 'api', error: 'gh: No commits between main and feature/a' });
});

test('with no forge CLI installed at all, that is what the user is told', async () => {
  const f = createForge({
    providers: [
      provider('github', { create: async () => ({ ok: false, stderr: '' }) }),
      provider('gitlab', { create: async () => ({ ok: false, stderr: '' }) }),
    ],
    isInstalled: () => false,
    pushBranch: OK_PUSH,
  });
  const r = await f.openPullRequest(MEMBER, {});
  assert.match(present(r.error, 'an error'), /no forge CLI installed/, 'a CLI that was never there did not "fail"');
});

test('openPullRequest falls back to a generic error when an installed provider fails mutely', async () => {
  const f = forge([provider('github', { create: async () => ({ ok: false, stderr: '' }) })]);
  assert.deepEqual(await f.openPullRequest(MEMBER, {}), { repo: 'api', error: 'gh/glab unavailable or failed' });
});

test('creation is attempted even for a CLI that is not installed', async () => {
  // Unlike lookups, PR creation has always shelled out unconditionally: a missing
  // CLI simply fails and the next provider gets its turn.
  let asked = false;
  const f = createForge({
    providers: [provider('github', { create: async () => { asked = true; return { ok: true, url: 'u' }; } })],
    isInstalled: () => false,
    pushBranch: OK_PUSH,
  });
  assert.deepEqual(await f.openPullRequest(MEMBER, {}), { repo: 'api', url: 'u' });
  assert.equal(asked, true);
});

test('the shipped providers are GitHub then GitLab', () => {
  assert.deepEqual(PROVIDERS.map((p) => [p.id, p.cli]), [['github', 'gh'], ['gitlab', 'glab']]);
});

// ---------------------------------------------------------------------------
// POST /group/pr as a CI trigger
// ---------------------------------------------------------------------------

// Serve a router carrying only the forge's routes, and hand fn a fetcher.
type Poster = (path: string, body: unknown) => Promise<Response>;
async function serving<T>(register: (api: Router) => void, fn: (post: Poster) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  const api = express.Router();
  app.use('/api', api);
  register(api);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (present(server.address()) as AddressInfo).port;
  try { return await fn((p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })); }
  finally { server.close(); }
}

const GROUP = { name: 'feat-a', members: [{ repo: 'api', path: NOT_A_REPO, branch: 'feature/a' }] };

test('opening a PR invalidates the cache and tells the push side to re-look', async () => {
  // A branch that had no PR a second ago has one now, and the cached `hasPR: false`
  // says otherwise — without this the pill would not appear until the TTL expired.
  let pokes = 0;
  let views = 0;
  const f = createForge({
    providers: [provider('github', {
      view: async () => (views++ ? GH_HIT : null), // no PR the first time, one after
      create: async () => ({ ok: true, url: 'https://gh/pr/1' }),
    })],
    isInstalled: () => true,
    pushBranch: OK_PUSH,
    resolveGroup: async () => ({ group: GROUP }),
    onChanged: () => { pokes++; },
  });

  assert.deepEqual(await f.ciForRepo({ repo: 'api', worktreePath: NOT_A_REPO, branch: 'feature/a' }, {}), { repo: 'api', hasPR: false });
  await serving((api) => f.register(api), async (post) => {
    const r = await jsonBody(await post('/api/group/pr', { group: 'feat-a' }));
    assert.equal(r.ok, true);
  });
  assert.equal(pokes, 1);
  assert.deepEqual(await f.ciForRepo({ repo: 'api', worktreePath: NOT_A_REPO, branch: 'feature/a' }, {}), { repo: 'api', ...GH_HIT },
    'the stale "no PR" answer was dropped, not re-served');
});

test('a group whose PRs all failed to open changes nothing', async () => {
  let pokes = 0;
  const f = createForge({
    providers: [provider('github', { create: async () => ({ ok: false, stderr: 'gh: not authenticated' }) })],
    isInstalled: () => true,
    pushBranch: OK_PUSH,
    resolveGroup: async () => ({ group: GROUP }),
    onChanged: () => { pokes++; },
  });
  await serving((api) => f.register(api), async (post) => {
    assert.equal((await jsonBody(await post('/api/group/pr', { group: 'feat-a' }))).ok, false);
  });
  assert.equal(pokes, 0, 'nothing changed, so nothing is refreshed');
});

test('a push listener that throws cannot break the PR route', async () => {
  const f = createForge({
    providers: [provider('github', { create: async () => ({ ok: true, url: 'https://gh/pr/1' }) })],
    isInstalled: () => true,
    pushBranch: OK_PUSH,
    resolveGroup: async () => ({ group: GROUP }),
    onChanged: () => { throw new Error('feed is on fire'); },
  });
  await serving((api) => f.register(api), async (post) => {
    const res = await post('/api/group/pr', { group: 'feat-a' });
    assert.equal(res.status, 200);
    assert.equal((await jsonBody(res)).ok, true);
  });
});

// ---------------------------------------------------------------------------
// the push half — a branch that never reached the remote has no PR to open
// ---------------------------------------------------------------------------

test('a rejected push stops before any PR is attempted and reports git\'s reason', async () => {
  let created = false;
  const f = createForge({
    providers: [provider('github', { create: async () => { created = true; return { ok: true, url: 'https://gh/pr/1' }; } })],
    isInstalled: () => true,
    pushBranch: async () => ({
      code: 1,
      stdout: '',
      // real non-fast-forward output: the complaint is not the first line
      stderr: 'To github.com:acme/api.git\n ! [rejected]        feature/a -> feature/a (fetch first)\nerror: failed to push some refs\n',
    }),
  });
  const r = await f.openPullRequest(MEMBER, {});
  assert.equal(created, false, 'a branch that is not on the remote cannot have a PR opened against it');
  assert.match(present(r.error, 'an error'), /^git push failed: /, String(r.error));
  assert.match(present(r.error, 'an error'), /\[rejected\]/, 'git\'s own complaint, not the progress line');
  assert.ok(!/github\.com:acme/.test(present(r.error, 'an error').replace(/\[rejected\][\s\S]*/, '')), 'the "To <remote>" progress line is not the error');
});

test('a real failing git push surfaces git\'s message instead of a PR-creation symptom', async () => {
  // No injection: this is `git -C <not a repo> push -u origin feature/a`.
  let created = false;
  const f = createForge({
    providers: [provider('github', { create: async () => { created = true; return { ok: false, stderr: 'gh: No commits between main and feature/a' }; } })],
    isInstalled: () => true,
  });
  const r = await f.openPullRequest(MEMBER, {});
  assert.equal(created, false);
  assert.match(present(r.error, 'an error'), /git push failed: fatal: not a git repository/i, String(r.error));
});

test('POST /group/pr reports a push failure as the failure', async () => {
  const f = createForge({
    providers: [provider('github', { create: async () => ({ ok: true, url: 'https://gh/pr/1' }) })],
    isInstalled: () => true,
    pushBranch: async () => ({ code: 128, stdout: '', stderr: "fatal: 'origin' does not appear to be a git repository\n" }),
    resolveGroup: async () => ({ group: GROUP }),
  });
  await serving((api) => f.register(api), async (post) => {
    const r = await jsonBody(await post('/api/group/pr', { group: 'feat-a' }));
    assert.equal(r.ok, false);
    assert.match(present(r.results[0].error, 'the member error'), /git push failed: fatal: 'origin' does not appear/);
  });
});

test('pushFailureLine picks the complaint out of git\'s progress noise', () => {
  assert.equal(pushFailureLine({ code: 1, stderr: 'To github.com:a/b.git\nerror: failed to push some refs\n' }), 'error: failed to push some refs');
  assert.equal(pushFailureLine({ code: 128, stderr: "fatal: 'origin' does not appear to be a git repository" }), "fatal: 'origin' does not appear to be a git repository");
  assert.equal(pushFailureLine({ code: 1, stderr: 'remote: Permission to a/b.git denied' }), 'remote: Permission to a/b.git denied');
  assert.equal(pushFailureLine({ stderr: '', stdout: '', code: 3 }), 'git push exited 3', 'a mute failure still says something');
});
