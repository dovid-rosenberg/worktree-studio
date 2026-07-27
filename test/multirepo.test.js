'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { SessionManager } = require('../server/sessions');

function tempRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wts-${name}-`));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

function manager() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-state-'));
  const cfg = { _stateDir: stateDir, _file: path.join(stateDir, 'config.json'), web: { port: 0 }, claude: { cmd: 'claude' }, baseDirs: [], copyPatterns: {} };
  const sent = [];
  const mux = { name: 'stub', async sendText(n, t) { sent.push(t); }, async paneCommand() { return 'node'; }, async ensure() { return {}; }, async kill() {}, async rename() { return false; }, async hasSession() { return false; } };
  const m = new SessionManager(cfg, mux);
  m._sent = sent;
  return m;
}

test('sessionForWorktree finds a session by ANY of its repos worktreePaths', () => {
  const m = manager();
  m.sessions.set('s1', { id: 's1', worktreePath: '/x/primary', repos: [
    { repo: 'a', worktreePath: '/x/primary', primary: true },
    { repo: 'b', worktreePath: '/y/sibling', primary: false },
  ] });
  assert.equal(m.sessionForWorktree('/x/primary').id, 's1');
  assert.equal(m.sessionForWorktree('/y/sibling').id, 's1', 'finds by a non-primary repo');
  assert.equal(m.sessionForWorktree('/nope'), null);
});

test('addRepo creates a same-named sibling worktree, tracks it, and grants /add-dir access', async () => {
  const m = manager();
  const repoB = tempRepo('b');
  m.sessions.set('s2', {
    id: 's2', feature: 'shared-feat', branch: 'feature/shared-feat', muxName: 'mux2',
    repos: [{ repo: 'a', repoPath: '/tmp/a', worktree: 'shared-feat', worktreePath: '/tmp/a/.worktrees/shared-feat', primary: true }],
  });
  const out = await m.addRepo('s2', { repo: 'b', repoPath: repoB });
  assert.equal(out.ok, true, out.error);
  // sibling worktree created with the SAME name as the feature (→ auto-groups)
  const wtPath = path.join(repoB, '.worktrees', 'shared-feat');
  assert.ok(fs.existsSync(wtPath), 'sibling worktree exists');
  // tracked on the session
  const s = m.get('s2');
  assert.equal(s.repos.length, 2);
  assert.equal(s.repos[1].repo, 'b');
  assert.equal(s.repos[1].worktreePath, wtPath);
  // live access granted via /add-dir
  assert.ok(m._sent.some((t) => t === `/add-dir ${wtPath}`), 'sent /add-dir to the session');
  // and findable
  assert.equal(m.sessionForWorktree(wtPath).id, 's2');
  fs.rmSync(repoB, { recursive: true, force: true });
});

test('addRepo is idempotent for a repo already in the feature', async () => {
  const m = manager();
  m.sessions.set('s3', { id: 's3', feature: 'f', branch: 'feature/f', muxName: 'm3', repos: [{ repo: 'a', repoPath: '/tmp/a', primary: true }] });
  const out = await m.addRepo('s3', { repo: 'a', repoPath: '/tmp/a' });
  assert.equal(out.already, true);
  assert.equal(m.get('s3').repos.length, 1);
});

test('restore() leaves a deactivated session stopped and does not relaunch it', async () => {
  const m = manager();
  const ensured = [];
  m.mux = { async ensure(n) { ensured.push(n); return {}; }, async hasSession() { return false; } };
  m.sessions.set('d1', { id: 'd1', muxName: 'mux-d1', active: false, state: 'stopped', createdAt: 1 });
  const n = await m.restore();
  assert.equal(n, 0, 'nothing restored');
  assert.equal(ensured.length, 0, 'mux.ensure not called for a deactivated session');
  assert.equal(m.get('d1').state, 'stopped');
});
