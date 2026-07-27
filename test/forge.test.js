'use strict';
// The forge boundary (server/forge.js): the check-tally tables that drive the CI
// pill, and the provider contract — GitHub first, GitLab as the fallback, cached,
// and never throwing out of a lookup. Providers are injected, so no gh/glab and no
// network are involved.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createForge, ghChecks, glChecks, PROVIDERS } = require('../server/forge');

// A worktree path that is deliberately NOT a git repo: openPullRequest pushes first,
// and a failed push is ignored exactly as it always was.
const NOT_A_REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-forge-'));

// A stand-in provider whose view/create are scripted per call.
function provider(id, { view = async () => null, create = async () => ({ ok: false, stderr: '' }) } = {}) {
  return { id, cli: id, view, create };
}

function forge(providers) {
  return createForge({ providers, isInstalled: () => true });
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
// openPullRequest — same order, last word on failure
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

test('openPullRequest reports the LAST provider\'s first stderr line when all refuse', async () => {
  const f = forge([
    provider('github', { create: async () => ({ ok: false, stderr: 'gh failed\nmore gh noise' }) }),
    provider('gitlab', { create: async () => ({ ok: false, stderr: '  glab: not authenticated\ntrace\n' }) }),
  ]);
  assert.deepEqual(await f.openPullRequest(MEMBER, {}), { repo: 'api', error: 'glab: not authenticated' });
});

test('openPullRequest falls back to a generic error when nothing said why', async () => {
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
  });
  assert.deepEqual(await f.openPullRequest(MEMBER, {}), { repo: 'api', url: 'u' });
  assert.equal(asked, true);
});

test('the shipped providers are GitHub then GitLab', () => {
  assert.deepEqual(PROVIDERS.map((p) => [p.id, p.cli]), [['github', 'gh'], ['gitlab', 'glab']]);
});
