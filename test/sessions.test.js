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

// `cfgExtra` lets a test pick a featureIdentity strategy; the manager builds its
// own resolver from cfg exactly as it does when server.js hands it the shared one.
function manager(cfgExtra = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-state-'));
  const cfg = { _stateDir: stateDir, _file: path.join(stateDir, 'config.json'), web: { port: 0 }, claude: { cmd: 'claude' }, baseDirs: [], copyPatterns: {}, ...cfgExtra };
  const sent = [];
  const mux = { name: 'stub', async sendText(n, t) { sent.push(t); }, async paneCommand() { return 'node'; }, async ensure() { return {}; }, async kill() {}, async rename() { return false; }, async hasSession() { return false; } };
  // `_sent` is this helper's own bookkeeping stapled to the instance — the mux stub
  // records what was typed into the session, and the tests assert on it.
  const m = /** @type {InstanceType<typeof SessionManager> & { _sent: string[] }} */ (new SessionManager(cfg, mux));
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

test('promote moves the live session into the worktree via /cd and re-anchors home there', async () => {
  const m = manager();
  const repo = tempRepo('promote-cd');
  m.sessions.set('p2', {
    id: 'p2', repoName: 'a', repoPath: repo, home: repo,
    worktree: null, worktreePath: null, branch: null, feature: 'orig',
    suggestedBranch: 'feature/x', suggestedName: 'x',
    muxName: 'mux-p2', pendingRepos: [],
    repos: [{ repo: 'a', repoPath: repo, worktree: null, worktreePath: null, branch: null, primary: true }],
    state: 'idle', active: true, createdAt: Date.now(),
  });

  const out = await m.promote('p2');
  assert.equal(out.ok, true, out.error);
  const wtPath = path.join(repo, '.worktrees', 'x');
  const s = m.get('p2');
  assert.ok(m._sent.includes(`/cd ${wtPath}`), 'sends /cd <worktree> to relocate cwd + transcript');
  assert.equal(s.home, wtPath, 'home re-anchors to the worktree so a later --resume finds the moved transcript');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('after promote, a resume launches straight from the worktree (no redundant /cd)', async () => {
  const m = manager();
  const repo = tempRepo('promote-resume');
  m.sessions.set('p3', {
    id: 'p3', repoName: 'a', repoPath: repo, home: repo,
    worktree: null, worktreePath: null, branch: null, feature: 'orig',
    suggestedBranch: 'feature/y', suggestedName: 'y',
    muxName: 'mux-p3', pendingRepos: [], claudeSessionId: 'sid-9',
    repos: [{ repo: 'a', repoPath: repo, worktree: null, worktreePath: null, branch: null, primary: true }],
    state: 'idle', active: true, createdAt: Date.now(),
  });
  await m.promote('p3');
  const s = m.get('p3');
  const wtPath = s.worktreePath;

  // simulate a restart: swap in a mux that records the resume cwd + any sends
  let cwd = null; const sent = [];
  m.mux = {
    async ensure(n, opts) { cwd = opts.cwd; return {}; },
    async paneCommand() { return 'node'; }, async sendText(n, t) { sent.push(t); },
    async kill() {}, async rename() { return false; }, async hasSession() { return false; },
  };
  s.active = false; s.state = 'stopped';
  await m.activate('p3');
  assert.equal(cwd, wtPath, 'resume launches from the worktree where the transcript now lives');
  assert.ok(!sent.includes(`/cd ${wtPath}`), 'no redundant /cd — home is already anchored to the worktree');

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

test('claudeCmd appends the seed as the final positional arg on a FRESH launch, and omits it on resume', () => {
  const m = manager();
  const s = { settingsFile: '/tmp/s.settings.json', feature: 'f', repos: [{ primary: true }], seed: 'fix the wallet bug', claudeSessionId: 'sid-9' };

  const fresh = m.claudeCmd(s);
  assert.ok(fresh.trimEnd().endsWith(shq('fix the wallet bug')), `seed should be the final arg on a fresh launch: ${fresh}`);
  assert.ok(!/ -r /.test(fresh), `fresh launch should not resume: ${fresh}`);

  const resumed = m.claudeCmd(s, { resume: true });
  assert.ok(!resumed.includes(shq('fix the wallet bug')), `seed must NOT be re-sent on resume: ${resumed}`);
  assert.ok(resumed.includes(`-r ${shq('sid-9')}`), `resume should still add -r <id>: ${resumed}`);
});

test('activate/restore resume cwd resolves to home (transcript dir) for a promoted session', async () => {
  const m = manager();
  const home = tempRepo('home');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-wt-'));
  let cwd = null;
  m.mux = {
    async ensure(n, opts) { cwd = opts.cwd; return {}; },
    async paneCommand() { return 'node'; }, async sendText() {},
    async kill() {}, async rename() { return false; }, async hasSession() { return false; },
  };
  m.sessions.set('r1', {
    id: 'r1', muxName: 'mux-r1', repoName: 'a', repoPath: home, home,
    worktree: 'feat', worktreePath: wt, branch: 'feature/feat',
    settingsFile: '/tmp/r1.settings.json', repos: [{ repo: 'a', primary: true }],
    claudeSessionId: 'sid-1', active: false, state: 'stopped', createdAt: Date.now(),
  });

  await m.activate('r1');
  assert.equal(cwd, home, 'resume launches from home (the transcript dir) so --resume resolves the conversation');

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(wt, { recursive: true, force: true });
});

test('restore flags a promoted session whose worktree dir is gone instead of faking a resume', async () => {
  const m = manager();
  const ensured = [];
  m.mux = { async ensure(n) { ensured.push(n); return {}; }, async hasSession() { return false; }, async sendText() {}, async paneCommand() { return 'node'; } };
  m.sessions.set('g1', {
    id: 'g1', muxName: 'mux-g1', repoPath: '/tmp/gone', home: '/tmp/gone',
    worktree: 'feat', worktreePath: '/tmp/does-not-exist-wts-xyz', branch: 'feature/feat',
    claudeSessionId: 'sid-1', active: true, state: 'idle', createdAt: Date.now(),
  });

  const n = await m.restore();
  assert.equal(n, 0, 'a session with a missing worktree is not counted as restored');
  assert.equal(ensured.length, 0, 'mux.ensure is not called for a missing worktree');
  const s = m.get('g1');
  assert.equal(s.state, 'stopped');
  assert.equal(s.activity, 'worktree missing');
});

test('tmux sendText sends the body literally (-l) then submits with a separate Enter', async (t) => {
  const tmux = require('../server/multiplexer/tmux');
  if (!(await tmux.available())) { t.skip('tmux not installed'); return; }
  const name = `wts-test-sendtext-${Date.now().toString(36)}`;
  const outFile = path.join(os.tmpdir(), `${name}.txt`);
  // `cat > file` writes each submitted line to the file; a literal send must land
  // tokens like `Enter`/`;` verbatim (an interpreted send would fire real keys).
  await tmux.ensure(name, { cwd: os.tmpdir(), cmd: `cat > ${shq(outFile)}` });
  try {
    // wait for cat to become the pane's foreground program
    for (let i = 0; i < 50 && (await tmux.paneCommand(name)) !== 'cat'; i++) await new Promise((r) => setTimeout(r, 100));
    const literal = 'echo hi; Enter Space done';
    await tmux.sendText(name, literal);
    let got = '';
    for (let i = 0; i < 50; i++) {
      got = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
      if (got.includes('done')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(got.trim(), literal, 'the exact literal string (incl. `;`/`Enter`) was delivered');
  } finally {
    await tmux.kill(name);
    fs.rmSync(outFile, { force: true });
  }
});

test('promote returns needsConfirm when the main checkout is dirty, and does not promote', async () => {
  const m = manager();
  const repo = tempRepo('dirty');
  fs.writeFileSync(path.join(repo, 'README.md'), '# uncommitted change\n'); // dirty the main checkout
  m.sessions.set('d1', {
    id: 'd1', repoName: 'a', repoPath: repo, home: repo,
    worktree: null, worktreePath: null, branch: null, feature: 'orig',
    suggestedBranch: 'feature/x', suggestedName: 'x', muxName: 'mux-d1', pendingRepos: [],
    repos: [{ repo: 'a', repoPath: repo, worktree: null, worktreePath: null, branch: null, primary: true }],
    state: 'idle', active: true, createdAt: Date.now(),
  });

  const out = await m.promote('d1');
  assert.equal(out.ok, false);
  assert.equal(out.needsConfirm, true);
  assert.ok(out.dirty.some((f) => /README\.md/.test(f)), `expected README in dirty list: ${JSON.stringify(out.dirty)}`);
  assert.equal(m.get('d1').worktreePath, null, 'session is not promoted while unconfirmed');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('promote with confirm:true proceeds past a dirty main and creates the worktree', async () => {
  const m = manager();
  const repo = tempRepo('dirty-confirm');
  fs.writeFileSync(path.join(repo, 'README.md'), '# uncommitted change\n');
  m.sessions.set('d2', {
    id: 'd2', repoName: 'a', repoPath: repo, home: repo,
    worktree: null, worktreePath: null, branch: null, feature: 'orig',
    suggestedBranch: 'feature/x', suggestedName: 'x', muxName: 'mux-d2', pendingRepos: [],
    repos: [{ repo: 'a', repoPath: repo, worktree: null, worktreePath: null, branch: null, primary: true }],
    state: 'idle', active: true, createdAt: Date.now(),
  });

  const out = await m.promote('d2', { confirm: true });
  assert.equal(out.ok, true, out.error);
  assert.ok(m.get('d2').worktreePath, 'promoted after confirm');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('reconcile flips a session whose mux session vanished to stopped and leaves a live one alone', async () => {
  const m = manager();
  m.mux = { async hasSession(n) { return n === 'live-mux'; } };
  m.sessions.set('dead', { id: 'dead', muxName: 'dead-mux', state: 'idle', active: true, createdAt: Date.now() });
  m.sessions.set('live', { id: 'live', muxName: 'live-mux', state: 'working', active: true, createdAt: Date.now() });

  await m.reconcile();

  const dead = m.get('dead');
  assert.equal(dead.state, 'stopped');
  assert.equal(dead.active, false);
  assert.equal(dead.activity, 'session ended');
  const live = m.get('live');
  assert.equal(live.state, 'working', 'a live session is left untouched');
  assert.equal(live.active, true);
});

test('reconcile leaves an already-stopped session untouched (no redundant flip)', async () => {
  const m = manager();
  let queried = 0;
  m.mux = { async hasSession() { queried++; return false; } };
  m.sessions.set('s1', { id: 's1', muxName: 'm', state: 'stopped', active: false, activity: 'deactivated', createdAt: Date.now() });

  await m.reconcile();

  assert.equal(queried, 0, 'does not even query the mux for a stopped/deactivated session');
  assert.equal(m.get('s1').activity, 'deactivated', 'activity is not overwritten');
});

// adopt launches claude in the worktree, so that's where the transcript lives —
// home must equal it or --resume (which resumes from home) can't find the conversation.
test('adopt sets home to the worktree launch dir (so resume resolves the conversation)', async () => {
  const m = manager();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-adopt-home-'));
  const s = await m.adopt({ worktreePath: wt, repoName: 'r', repoPath: '/tmp/r', branch: 'b', wtname: 'feat' });
  assert.ok(s && s.id, 'session adopted');
  assert.equal(s.home, wt, 'home is the worktree (launch/transcript dir), not repoPath');
  fs.rmSync(wt, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// session.feature is the feature IDENTITY, not the worktree name
//
// `POST /group/pr { group: session.feature }` (public/app.js) resolves that value
// against the feature names state.js computes with server/identity.js. Under
// `basename` the identity and the worktree name coincide, which is why storing the
// name was latent; under `branch`/`manifest` they differ and the lookup 404s.
// ---------------------------------------------------------------------------

const { computeFeatures } = require('../server/features');
const { createIdentity } = require('../server/identity');

// Group `fix/4821-payments` and `feat/4821-ui` both onto the ticket number 4821.
const BY_TICKET = { featureIdentity: { strategy: 'branch', branchPattern: '^(?:fix|feat|feature)/(\\d+)' } };

test('promote stores the feature identity, and still NAMES the worktree by name', async () => {
  const m = manager(BY_TICKET);
  const repo = tempRepo('ident-promote');
  m.sessions.set('i1', {
    id: 'i1', repoName: 'api', repoPath: repo, home: repo,
    worktree: null, worktreePath: null, branch: null, feature: 'placeholder',
    suggestedBranch: 'fix/4821-payments', suggestedName: 'payments',
    muxName: 'mux-i1', pendingRepos: [],
    repos: [{ repo: 'api', repoPath: repo, worktree: null, worktreePath: null, branch: null, primary: true }],
    state: 'idle', active: true, createdAt: Date.now(),
  });

  const out = await m.promote('i1');
  assert.equal(out.ok, true, out.error);
  const s = m.get('i1');

  // naming is untouched — the directory is still the worktree name
  assert.equal(s.worktree, 'payments');
  assert.ok(fs.existsSync(path.join(repo, '.worktrees', 'payments')), 'worktree dir is named after the worktree');
  // grouping is the identity
  assert.equal(s.feature, '4821', 'the stored feature is the identity the branch strategy resolves');

  // …and that value is exactly what a /group/* lookup would find.
  const identity = createIdentity(BY_TICKET);
  const wt = { repo: 'api', wtname: s.worktree, branch: s.branch, path: s.worktreePath };
  const { features } = computeFeatures([wt], [], identity);
  assert.ok(features.some((f) => f.name === s.feature), `no feature named ${s.feature} in ${features.map((f) => f.name).join(', ')}`);

  fs.rmSync(repo, { recursive: true, force: true });
});

test('adopt stores the identity of the worktree it adopted', async () => {
  const m = manager(BY_TICKET);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-ident-adopt-'));
  const s = await m.adopt({ worktreePath: wt, repoName: 'api', repoPath: '/tmp/api', branch: 'feat/4821-ui', wtname: 'ui-work' });
  assert.equal(s.worktree, 'ui-work', 'the worktree keeps its own name');
  assert.equal(s.feature, '4821', 'the session records the identity, not the name');
  fs.rmSync(wt, { recursive: true, force: true });
});

test('addRepo names the sibling worktree after the worktree, never after the identity', async () => {
  // The identity here is `4821` — a ticket number, not a directory name. Creating
  // `<repo>/.worktrees/4821` would be a silent renaming of the user's worktrees.
  const m = manager(BY_TICKET);
  const repoB = tempRepo('ident-addrepo');
  m.sessions.set('i2', {
    id: 'i2', feature: '4821', worktree: 'payments', branch: 'fix/4821-payments', muxName: 'mux-i2',
    repos: [{ repo: 'api', repoPath: '/tmp/api', worktree: 'payments', worktreePath: '/tmp/api/.worktrees/payments', primary: true }],
  });
  const out = await m.addRepo('i2', { repo: 'fe', repoPath: repoB });
  assert.equal(out.ok, true, out.error);
  assert.ok(fs.existsSync(path.join(repoB, '.worktrees', 'payments')), 'sibling worktree keeps the feature\'s worktree name');
  assert.ok(!fs.existsSync(path.join(repoB, '.worktrees', '4821')), 'the grouping key was not used as a directory name');
  fs.rmSync(repoB, { recursive: true, force: true });
});

test('a session persisted before worktree name and identity were told apart still names siblings', async () => {
  // Back-compat: old sessions.json rows carry `feature` and nothing else naming-ish.
  const m = manager();
  const repoB = tempRepo('ident-legacy');
  m.sessions.set('old', {
    id: 'old', feature: 'legacy-feat', branch: 'feature/legacy-feat', muxName: 'mux-old',
    repos: [{ repo: 'api', repoPath: '/tmp/api', primary: true }],
  });
  const out = await m.addRepo('old', { repo: 'fe', repoPath: repoB });
  assert.equal(out.ok, true, out.error);
  assert.ok(fs.existsSync(path.join(repoB, '.worktrees', 'legacy-feat')), 'falls back to the stored feature exactly as before');
  fs.rmSync(repoB, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// restore()
// ---------------------------------------------------------------------------

// Three restorable sessions in a known order (all() sorts newest-first).
function restorable(m, ids) {
  ids.forEach((id, i) => m.sessions.set(id, {
    id, title: id, repoName: 'api', repoPath: m.cfg._stateDir, home: m.cfg._stateDir,
    worktree: null, worktreePath: null, branch: null, feature: id,
    repos: [{ repo: 'api', repoPath: m.cfg._stateDir, primary: true }],
    muxName: `mux-${id}`, tabs: [{ title: 'claude' }], claudeSessionId: null,
    state: 'idle', active: true, createdAt: ids.length - i,
  }));
}

test('restore() carries on past a session it cannot relaunch, and still saves', async () => {
  const m = manager();
  restorable(m, ['a', 'b', 'c']);
  const launched = [];
  m.mux.ensure = async (name) => { launched.push(name); return {}; };
  // _writeHookSettings is a mkdirSync + writeFileSync — an EACCES or a full disk
  // throws right here, which is the failure this guard exists for.
  const real = m._writeHookSettings.bind(m);
  m._writeHookSettings = (s) => { if (s.id === 'b') throw new Error('EACCES: permission denied'); return real(s); };

  const n = await m.restore();

  assert.equal(n, 2, 'the two healthy sessions were relaunched');
  assert.deepEqual(launched, ['mux-a', 'mux-c'], 'the session AFTER the failure was still reached');
  assert.equal(m.get('b').state, 'stopped');
  assert.match(m.get('b').activity, /restore failed: EACCES/, 'the failure is recorded on the session itself');
  assert.equal(m.get('c').activity, 'restarted');
  // _save() must still run, or the on-disk state keeps claiming everything is fine.
  const saved = JSON.parse(fs.readFileSync(m.file, 'utf8'));
  assert.equal(saved.find((s) => s.id === 'b').state, 'stopped');
  assert.equal(saved.find((s) => s.id === 'c').activity, 'restarted');
});

test('restore() reports a count that a caller can distinguish from failure', async () => {
  const m = manager();
  restorable(m, ['a']);
  assert.equal(await m.restore(), 1);
  const empty = manager();
  assert.equal(await empty.restore(), 0, 'no sessions is still 0 — the difference has to come from the throw');
});
