'use strict';
// The review/hunk route module. Express itself isn't exercised here — a fake router
// records what got mounted and the handlers are invoked directly, which is enough to
// pin down the contract that matters: the route table is what it claims to be, the
// session/repo lookup rejects what it should, and a refused stage is a 400 (the
// caller's problem) rather than a 500.
//
// The /api + /api/v1 equivalence is NOT asserted here any more: the module registers
// onto the one router server.js mounts at both prefixes, so it cannot spell a prefix
// at all. That the two prefixes really answer alike is proved end-to-end against a
// live express app in api-routing.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const routes = require('../server/routes-review');

function sh(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }

// Records mounts and lets a test call one back by method + path.
function fakeApp() {
  const mounted = { get: [], post: [] };
  const handlers = new Map();
  const record = (method) => (p, fn) => { mounted[method].push(p); handlers.set(`${method} ${p}`, fn); };
  return {
    get: record('get'),
    post: record('post'),
    mounted,
    // Invoke a handler and resolve with { status, body } once it responds.
    call(method, p, req = {}) {
      const fn = handlers.get(`${method} ${p}`);
      assert.ok(fn, `no handler for ${method} ${p}`);
      return new Promise((resolve) => {
        const res = {
          headersSent: false,
          statusCode: 200,
          status(code) { this.statusCode = code; return this; },
          json(body) { this.headersSent = true; resolve({ status: this.statusCode, body }); },
        };
        fn({ params: {}, query: {}, body: {}, ...req }, res);
      });
    },
  };
}

// A session whose single repo points at a throwaway worktree with a two-hunk change.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-routes-'));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 't@t.t']);
  sh(dir, ['config', 'user.name', 't']);
  const lines = Array.from({ length: 30 }, (_, i) => `L${i + 1}`);
  fs.writeFileSync(path.join(dir, 'f.txt'), `${lines.join('\n')}\n`);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-qm', 'base']);
  const changed = [...lines];
  changed[1] = 'L2 CHANGED';
  changed[24] = 'L25 CHANGED';
  fs.writeFileSync(path.join(dir, 'f.txt'), `${changed.join('\n')}\n`);
  const session = { id: 's1', repos: [{ repo: 'demo', worktreePath: dir }] };
  const deps = {
    manager: { get: (id) => (id === 's1' ? session : null) },
    repos: () => [{ name: 'demo', defaultBranch: 'main' }],
    broadcast: () => { deps.broadcasts += 1; },
    broadcasts: 0,
  };
  return { dir, deps };
}

function registered() {
  const app = fakeApp();
  const { dir, deps } = fixture();
  routes.register(app, deps);
  return { app, dir, deps };
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

test('register() mounts the documented route table, once each', () => {
  const { app, dir } = registered();
  assert.deepEqual(app.mounted.get, ['/sessions/:id/diff', '/sessions/:id/hunks']);
  assert.deepEqual(app.mounted.post, ['/sessions/:id/hunks/stage', '/sessions/:id/hunks/unstage']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('register() spells no prefix — the router it is handed owns /api and /api/v1', () => {
  const { app, dir } = registered();
  for (const p of [...app.mounted.get, ...app.mounted.post]) {
    assert.doesNotMatch(p, /^\/api/, `${p} hardcodes a prefix instead of riding the router's`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('register() refuses to wire up without a session manager', () => {
  assert.throws(() => routes.register(fakeApp(), {}), /manager/);
});

// ---------------------------------------------------------------------------
// GET /sessions/:id/diff — the structured model
// ---------------------------------------------------------------------------

test('GET diff returns the working-tree files with hunks and side-by-side rows', async () => {
  const { app, dir } = registered();
  const r = await app.call('get', '/sessions/:id/diff', { params: { id: 's1' }, query: { repo: 'demo' } });
  assert.equal(r.status, 200);
  const f = r.body.files.find((x) => x.file === 'f.txt');
  assert.equal(f.parsed.hunks.length, 2);
  assert.ok(f.parsed.hunks[0].rows.some((row) => row.type === 'change'), 'rows are aligned for side-by-side');
  assert.match(f.diff, /^\+L2 CHANGED$/m, 'the raw patch is still there alongside the model');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET diff defaults to the uncommitted entry', async () => {
  const { app, dir } = registered();
  const r = await app.call('get', '/sessions/:id/diff', { params: { id: 's1' } });
  assert.equal(r.body.sha, 'uncommitted');
  assert.equal(r.body.repo, 'demo', 'a single-repo session need not name its repo');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET diff of a commit returns that commit’s files', async () => {
  const { app, dir } = registered();
  const sha = sh(dir, ['rev-parse', 'HEAD']).trim();
  const r = await app.call('get', '/sessions/:id/diff', { params: { id: 's1' }, query: { repo: 'demo', sha } });
  assert.equal(r.body.sha, sha);
  assert.equal(r.body.files[0].file, 'f.txt');
  assert.equal(r.body.files[0].parsed.status, 'added');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET diff 404s for an unknown session and 400s for an unknown repo', async () => {
  const { app, dir } = registered();
  const missing = await app.call('get', '/sessions/:id/diff', { params: { id: 'nope' } });
  assert.equal(missing.status, 404);
  const wrongRepo = await app.call('get', '/sessions/:id/diff', { params: { id: 's1' }, query: { repo: 'other' } });
  assert.equal(wrongRepo.status, 400);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GET /sessions/:id/hunks + the stage/unstage pair
// ---------------------------------------------------------------------------

test('GET hunks splits a file into a stageable and an unstageable side', async () => {
  const { app, dir } = registered();
  const r = await app.call('get', '/sessions/:id/hunks', { params: { id: 's1' }, query: { repo: 'demo', file: 'f.txt' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.unstaged.hunks.length, 2);
  assert.equal(r.body.staged, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET hunks requires a file', async () => {
  const { app, dir } = registered();
  const r = await app.call('get', '/sessions/:id/hunks', { params: { id: 's1' }, query: { repo: 'demo' } });
  assert.equal(r.status, 400);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('POST hunks/stage stages just that hunk and broadcasts the change', async () => {
  const { app, dir, deps } = registered();
  const r = await app.call('post', '/sessions/:id/hunks/stage', {
    params: { id: 's1' }, body: { repo: 'demo', file: 'f.txt', hunks: [0] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const staged = sh(dir, ['diff', '--cached']);
  assert.match(staged, /^\+L2 CHANGED$/m);
  assert.doesNotMatch(staged, /L25 CHANGED/);
  assert.equal(deps.broadcasts, 1, 'the UI is told the index moved');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('POST hunks/stage accepts the `hunk` singular shorthand', async () => {
  const { app, dir } = registered();
  const r = await app.call('post', '/sessions/:id/hunks/stage', {
    params: { id: 's1' }, body: { repo: 'demo', file: 'f.txt', hunk: 1 },
  });
  assert.equal(r.body.ok, true);
  assert.match(sh(dir, ['diff', '--cached']), /^\+L25 CHANGED$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('POST hunks/unstage puts a staged hunk back', async () => {
  const { app, dir } = registered();
  sh(dir, ['add', 'f.txt']);
  const r = await app.call('post', '/sessions/:id/hunks/unstage', {
    params: { id: 's1' }, body: { repo: 'demo', file: 'f.txt', hunks: [0] },
  });
  assert.equal(r.body.ok, true);
  assert.doesNotMatch(sh(dir, ['diff', '--cached']), /L2 CHANGED/);
  assert.match(sh(dir, ['diff', '--cached']), /^\+L25 CHANGED$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a refused stage is a 400 carrying the reason, and stages nothing', async () => {
  const { app, dir, deps } = registered();
  const r = await app.call('post', '/sessions/:id/hunks/stage', {
    params: { id: 's1' }, body: { repo: 'demo', file: 'f.txt', hunks: [9] },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /indexes/);
  assert.equal(sh(dir, ['diff', '--cached']), '');
  assert.equal(deps.broadcasts, 0, 'nothing changed, so nothing to broadcast');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('selection() reads either the `hunks` array, the `hunks` scalar or `hunk`', () => {
  assert.deepEqual(routes.selection({ hunks: [1, 2] }), [1, 2]);
  assert.deepEqual(routes.selection({ hunks: 3 }), [3]);
  assert.deepEqual(routes.selection({ hunk: 0 }), [0], 'index 0 is a real selection, not a missing one');
  assert.deepEqual(routes.selection({}), []);
});

// ---------------------------------------------------------------------------
// ?sha= is untrusted input on its way to a git argv
// ---------------------------------------------------------------------------

test('GET /sessions/:id/diff refuses a sha that is really a git option, with a 400', async () => {
  const { app, dir } = registered();
  const victim = path.join(os.tmpdir(), `wts-route-victim-${process.pid}-${Date.now()}.txt`);
  fs.rmSync(victim, { force: true });

  const r = await app.call('get', '/sessions/:id/diff', { params: { id: 's1' }, query: { sha: `--output=${victim}` } });

  assert.equal(r.status, 400, 'a bad request, not a 500 and certainly not a 200');
  assert.equal(fs.existsSync(victim), false, `a GET wrote ${victim}`);
  fs.rmSync(victim, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET /sessions/:id/diff still defaults to the working tree and accepts a real sha', async () => {
  const { app, dir } = registered();
  const working = await app.call('get', '/sessions/:id/diff', { params: { id: 's1' }, query: {} });
  assert.equal(working.status, 200);
  assert.equal(working.body.sha, 'uncommitted');

  const sha = sh(dir, ['rev-parse', 'HEAD']).trim();
  const commit = await app.call('get', '/sessions/:id/diff', { params: { id: 's1' }, query: { sha } });
  assert.equal(commit.status, 200);
  assert.deepEqual(commit.body.files.map((f) => f.file), ['f.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});
