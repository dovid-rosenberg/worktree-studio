'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { SessionManager } = require('../server/sessions');
const { shq } = require('../server/util');

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
  const mux = { name: 'stub', async sendText(n, t) { sent.push(t); }, async ensure() { return {}; }, async kill() {}, async rename() { return false; }, async hasSession() { return false; } };
  const m = new SessionManager(cfg, mux);
  m._sent = sent;
  return m;
}

function branchOf(wtPath) {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wtPath }).toString().trim();
}

test('promote creates a worktree on the derived branch and updates the session + primary repo entry', async () => {
  const m = manager();
  const repo = tempRepo('promote');
  m.sessions.set('p1', {
    id: 'p1', repoName: 'a', repoPath: repo, home: repo,
    worktree: null, worktreePath: null, branch: null, feature: 'orig-feature',
    suggestedBranch: 'feature/my-feat', suggestedName: 'my-feat',
    muxName: 'mux-p1', pendingRepos: [],
    repos: [{ repo: 'a', repoPath: repo, worktree: null, worktreePath: null, branch: null, primary: true }],
    state: 'idle', active: true, createdAt: Date.now(),
  });

  const out = await m.promote('p1');
  assert.equal(out.ok, true, out.error);

  const wtPath = path.join(repo, '.worktrees', 'my-feat');
  assert.ok(fs.existsSync(wtPath), 'worktree dir exists');
  assert.equal(branchOf(wtPath), 'feature/my-feat', 'worktree is checked out on the derived branch');

  const s = m.get('p1');
  assert.equal(s.worktreePath, wtPath);
  assert.equal(s.branch, 'feature/my-feat');
  assert.equal(s.feature, 'my-feat', 'feature identity becomes the worktree name');
  assert.equal(s.repos[0].worktreePath, wtPath, 'primary repo entry gets the worktree path');
  assert.equal(s.repos[0].branch, 'feature/my-feat', 'primary repo entry gets the branch');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('activate resumes with -r <claudeSessionId> and marks activity resumed when a claude session id is known', async () => {
  const m = manager();
  let cmd = null;
  m.mux = { async ensure(n, opts) { cmd = opts.cmd; return {}; }, async kill() {}, async rename() { return false; }, async hasSession() { return false; }, async sendText() {} };
  m.sessions.set('a1', {
    id: 'a1', muxName: 'mux-a1', repoPath: '/tmp/a', home: '/tmp/a', worktreePath: null,
    settingsFile: '/tmp/a1.settings.json', repos: [{ repo: 'a', primary: true }],
    claudeSessionId: 'sid-1', active: false, state: 'stopped', createdAt: Date.now(),
  });

  const r = await m.activate('a1');
  assert.equal(r.ok, true);
  assert.ok(cmd.includes(`-r ${shq('sid-1')}`), `expected -r flag in: ${cmd}`);
  assert.equal(m.get('a1').activity, 'resumed');
});

test('activate launches without -r and marks activity restarted when there is no claude session id', async () => {
  const m = manager();
  let cmd = null;
  m.mux = { async ensure(n, opts) { cmd = opts.cmd; return {}; }, async kill() {}, async rename() { return false; }, async hasSession() { return false; }, async sendText() {} };
  m.sessions.set('a2', {
    id: 'a2', muxName: 'mux-a2', repoPath: '/tmp/a', home: '/tmp/a', worktreePath: null,
    settingsFile: '/tmp/a2.settings.json', repos: [{ repo: 'a', primary: true }],
    claudeSessionId: null, active: false, state: 'stopped', createdAt: Date.now(),
  });

  await m.activate('a2');
  assert.ok(!/ -r /.test(cmd), `expected no -r flag in: ${cmd}`);
  assert.equal(m.get('a2').activity, 'restarted');
});

test('applyHook SessionStart records the claude session id and sets an idle state', () => {
  const m = manager();
  m.sessions.set('h1', { id: 'h1', muxName: 'm', pendingPrompt: null, claudeSessionId: null, state: 'working', active: true, createdAt: Date.now() });
  m.applyHook('h1', 'SessionStart', { session_id: 'claude-abc' });
  const s = m.get('h1');
  assert.equal(s.claudeSessionId, 'claude-abc');
  assert.equal(s.state, 'idle');
});

test('applyHook UserPromptSubmit moves the session to working', () => {
  const m = manager();
  m.sessions.set('h2', { id: 'h2', muxName: 'm', state: 'idle', active: true, createdAt: Date.now() });
  m.applyHook('h2', 'UserPromptSubmit', {});
  assert.equal(m.get('h2').state, 'working');
});

test('applyHook Notification moves the session to waiting', () => {
  const m = manager();
  m.sessions.set('h3', { id: 'h3', muxName: 'm', state: 'working', active: true, createdAt: Date.now() });
  m.applyHook('h3', 'Notification', { message: 'need input' });
  assert.equal(m.get('h3').state, 'waiting');
});

test('applyHook Stop moves the session back to idle', () => {
  const m = manager();
  m.sessions.set('h4', { id: 'h4', muxName: 'm', state: 'working', active: true, createdAt: Date.now() });
  m.applyHook('h4', 'Stop', {});
  assert.equal(m.get('h4').state, 'idle');
});

test('applyHook SessionEnd deactivates the session and marks it stopped', () => {
  const m = manager();
  m.sessions.set('h5', { id: 'h5', muxName: 'm', state: 'idle', active: true, createdAt: Date.now() });
  m.applyHook('h5', 'SessionEnd', {});
  const s = m.get('h5');
  assert.equal(s.active, false);
  assert.equal(s.state, 'stopped');
});
