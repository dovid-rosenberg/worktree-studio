import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { SessionManager } from '../server/sessions.ts';
import { loadSessions } from '../server/session-store.ts';
import { shq } from '../server/util.ts';
import { CONFIG_DIR } from '../server/config.ts';
import type { Session, Worktree } from '../server/types.ts';
import type { PartialDeep, Config } from '../server/types.ts';
import { expectOk, muxStub, present, session, sessionRepo } from './helpers.ts';

function tempRepo(name: string): string {
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
// own resolver from cfg exactly as it does when server.ts hands it the shared one.
function manager(cfgExtra: PartialDeep<Config> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-state-'));
  const cfg: PartialDeep<Config> = {
    _stateDir: stateDir,
    _file: path.join(stateDir, 'config.json'),
    web: { port: 0 },
    claude: { cmd: 'claude' },
    baseDirs: [],
    copyPatterns: {},
    ...cfgExtra,
  };
  const sent: string[] = [];
  const mux = muxStub({
    async sendText(_n: string, t: string) {
      sent.push(t);
    },
  });
  // `_sent` is this helper's own bookkeeping stapled to the instance — the mux stub
  // records what was typed into the session, and the tests assert on it.
  const m = new SessionManager(cfg, mux) as SessionManager & { _sent: string[] };
  m._sent = sent;
  return m;
}

/** The session the test just put there; a miss is the test's own bug. */
function got(m: SessionManager, id: string): Session {
  return present(m.get(id), `session ${id}`);
}

function branchOf(wtPath: string): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wtPath }).toString().trim();
}

test('promote creates a worktree on the derived branch and updates the session + primary repo entry', async () => {
  const m = manager();
  const repo = tempRepo('promote');
  m.sessions.set(
    'p1',
    session({
      id: 'p1',
      repoName: 'a',
      repoPath: repo,
      home: repo,
      worktree: null,
      worktreePath: null,
      branch: null,
      feature: 'orig-feature',
      suggestedBranch: 'feature/my-feat',
      suggestedName: 'my-feat',
      muxName: 'mux-p1',
      pendingRepos: [],
      repos: [sessionRepo({ repo: 'a', repoPath: repo, primary: true })],
      state: 'idle',
      active: true,
      createdAt: Date.now(),
    }),
  );

  const out = await m.promote('p1');
  expectOk(out);

  const wtPath = path.join(repo, '.worktrees', 'my-feat');
  assert.ok(fs.existsSync(wtPath), 'worktree dir exists');
  assert.equal(branchOf(wtPath), 'feature/my-feat', 'worktree is checked out on the derived branch');

  const s = got(m, 'p1');
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
  m.sessions.set(
    'p2',
    session({
      id: 'p2',
      repoName: 'a',
      repoPath: repo,
      home: repo,
      worktree: null,
      worktreePath: null,
      branch: null,
      feature: 'orig',
      suggestedBranch: 'feature/x',
      suggestedName: 'x',
      muxName: 'mux-p2',
      pendingRepos: [],
      repos: [sessionRepo({ repo: 'a', repoPath: repo, primary: true })],
      state: 'idle',
      active: true,
      createdAt: Date.now(),
    }),
  );

  const out = await m.promote('p2');
  expectOk(out);
  const wtPath = path.join(repo, '.worktrees', 'x');
  const s = got(m, 'p2');
  assert.ok(m._sent.includes(`/cd ${wtPath}`), 'sends /cd <worktree> to relocate cwd + transcript');
  assert.equal(
    s.home,
    wtPath,
    'home re-anchors to the worktree so a later --resume finds the moved transcript',
  );

  fs.rmSync(repo, { recursive: true, force: true });
});

test('after promote, a resume launches straight from the worktree (no redundant /cd)', async () => {
  const m = manager();
  const repo = tempRepo('promote-resume');
  m.sessions.set(
    'p3',
    session({
      id: 'p3',
      repoName: 'a',
      repoPath: repo,
      home: repo,
      worktree: null,
      worktreePath: null,
      branch: null,
      feature: 'orig',
      suggestedBranch: 'feature/y',
      suggestedName: 'y',
      muxName: 'mux-p3',
      pendingRepos: [],
      claudeSessionId: 'sid-9',
      repos: [sessionRepo({ repo: 'a', repoPath: repo, primary: true })],
      state: 'idle',
      active: true,
      createdAt: Date.now(),
    }),
  );
  await m.promote('p3');
  const s = got(m, 'p3');
  const wtPath = s.worktreePath;

  // simulate a restart: swap in a mux that records the resume cwd + any sends
  let cwd: string | null = null;
  const sent: string[] = [];
  m.mux = muxStub({
    async ensure(_n, opts) {
      cwd = opts?.cwd ?? null;
      return {};
    },
    async sendText(_n, t) {
      sent.push(t);
    },
  });
  s.active = false;
  s.state = 'stopped';
  await m.activate('p3');
  assert.equal(cwd, wtPath, 'resume launches from the worktree where the transcript now lives');
  assert.ok(!sent.includes(`/cd ${wtPath}`), 'no redundant /cd — home is already anchored to the worktree');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('activate resumes with -r <claudeSessionId> and marks activity resumed when a claude session id is known', async () => {
  const m = manager();
  let cmd = ''; // '' means ensure() was never called
  m.mux = muxStub({
    async ensure(_n, opts) {
      cmd = opts?.cmd ?? '';
      return {};
    },
  });
  m.sessions.set(
    'a1',
    session({
      id: 'a1',
      muxName: 'mux-a1',
      repoPath: '/tmp/a',
      home: '/tmp/a',
      worktreePath: null,
      settingsFile: '/tmp/a1.settings.json',
      repos: [sessionRepo({ repo: 'a', primary: true })],
      claudeSessionId: 'sid-1',
      active: false,
      state: 'stopped',
      createdAt: Date.now(),
    }),
  );

  expectOk(await m.activate('a1'), 'activate()');
  assert.ok(cmd.includes(`-r ${shq('sid-1')}`), `expected -r flag in: ${cmd}`);
  assert.equal(got(m, 'a1').activity, 'resumed');
});

test('activate launches without -r and marks activity restarted when there is no claude session id', async () => {
  const m = manager();
  let cmd = ''; // '' means ensure() was never called
  m.mux = muxStub({
    async ensure(_n, opts) {
      cmd = opts?.cmd ?? '';
      return {};
    },
  });
  m.sessions.set(
    'a2',
    session({
      id: 'a2',
      muxName: 'mux-a2',
      repoPath: '/tmp/a',
      home: '/tmp/a',
      worktreePath: null,
      settingsFile: '/tmp/a2.settings.json',
      repos: [sessionRepo({ repo: 'a', primary: true })],
      claudeSessionId: null,
      active: false,
      state: 'stopped',
      createdAt: Date.now(),
    }),
  );

  await m.activate('a2');
  assert.ok(!/ -r /.test(cmd), `expected no -r flag in: ${cmd}`);
  assert.equal(got(m, 'a2').activity, 'restarted');
});

test('applyHook SessionStart records the claude session id and sets an idle state', () => {
  const m = manager();
  m.sessions.set(
    'h1',
    session({
      id: 'h1',
      muxName: 'm',
      claudeSessionId: null,
      state: 'working',
      active: true,
      createdAt: Date.now(),
    }),
  );
  m.applyHook('h1', 'SessionStart', { session_id: 'claude-abc' });
  const s = got(m, 'h1');
  assert.equal(s.claudeSessionId, 'claude-abc');
  assert.equal(s.state, 'idle');
});

test('applyHook UserPromptSubmit moves the session to working', () => {
  const m = manager();
  m.sessions.set(
    'h2',
    session({ id: 'h2', muxName: 'm', state: 'idle', active: true, createdAt: Date.now() }),
  );
  m.applyHook('h2', 'UserPromptSubmit', {});
  assert.equal(got(m, 'h2').state, 'working');
});

test('applyHook Notification moves the session to waiting', () => {
  const m = manager();
  m.sessions.set(
    'h3',
    session({ id: 'h3', muxName: 'm', state: 'working', active: true, createdAt: Date.now() }),
  );
  m.applyHook('h3', 'Notification', { message: 'need input' });
  assert.equal(got(m, 'h3').state, 'waiting');
});

test('applyHook Stop moves the session back to idle', () => {
  const m = manager();
  m.sessions.set(
    'h4',
    session({ id: 'h4', muxName: 'm', state: 'working', active: true, createdAt: Date.now() }),
  );
  m.applyHook('h4', 'Stop', {});
  assert.equal(got(m, 'h4').state, 'idle');
});

test('applyHook SessionEnd deactivates the session and marks it stopped', () => {
  const m = manager();
  m.sessions.set(
    'h5',
    session({ id: 'h5', muxName: 'm', state: 'idle', active: true, createdAt: Date.now() }),
  );
  m.applyHook('h5', 'SessionEnd', {});
  const s = got(m, 'h5');
  assert.equal(s.active, false);
  assert.equal(s.state, 'stopped');
});

test('claudeCmd appends the seed as the final positional arg on a FRESH launch, and omits it on resume', () => {
  const m = manager();
  const s = session({
    settingsFile: '/tmp/s.settings.json',
    feature: 'f',
    repos: [sessionRepo({ primary: true })],
    seed: 'fix the wallet bug',
    claudeSessionId: 'sid-9',
  });

  const fresh = m.claudeCmd(s);
  assert.ok(
    fresh.trimEnd().endsWith(shq('fix the wallet bug')),
    `seed should be the final arg on a fresh launch: ${fresh}`,
  );
  assert.ok(!/ -r /.test(fresh), `fresh launch should not resume: ${fresh}`);

  const resumed = m.claudeCmd(s, { resume: true });
  assert.ok(!resumed.includes(shq('fix the wallet bug')), `seed must NOT be re-sent on resume: ${resumed}`);
  assert.ok(resumed.includes(`-r ${shq('sid-9')}`), `resume should still add -r <id>: ${resumed}`);
});

test('the add-repo CLI path in the system prompt actually exists on disk', () => {
  /*
   * The bug: the hint was built as `bin/wt-studio.js` while the file is `bin/wt-studio.ts`
   * — the CLI moved with the TypeScript migration and this string did not. Every session's
   * --append-system-prompt told the agent to run a path that does not exist, so `add-repo`
   * failed from inside a session with a module-not-found nobody could place.
   *
   * Asserting the extension would just re-encode the mistake, so this stats the file the
   * prompt actually names: rename the CLI again and this fails.
   */
  const m = manager();
  const s = session({
    settingsFile: '/tmp/s.settings.json',
    feature: 'f',
    repos: [sessionRepo({ primary: true })],
  });
  const cmd = m.claudeCmd(s);

  const found = cmd.match(/(\S*bin\/wt-studio\.\w+)/);
  assert.ok(found, `the prompt should name the add-repo CLI: ${cmd}`);
  assert.ok(fs.existsSync(found[1]), `the prompt names a CLI that does not exist: ${found[1]}`);

  /*
   * EXISTING is not the same as RUNNABLE.
   *
   * The prompt says "run: <path> add-repo <repo>" — a bare command, not `node <path>` —
   * and the file was mode 644 with a shebang. So the agent got `permission denied`, which
   * is a different dead end from the module-not-found above and equally unplaceable. The
   * previous fix checked that the path resolved and stopped one step short.
   */
  fs.accessSync(found[1], fs.constants.X_OK);
});

test('activate/restore resume cwd resolves to home (transcript dir) for a promoted session', async () => {
  const m = manager();
  const home = tempRepo('home');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-wt-'));
  let cwd: string | null = null;
  m.mux = muxStub({
    async ensure(_n, opts) {
      cwd = opts?.cwd ?? null;
      return {};
    },
  });
  m.sessions.set(
    'r1',
    session({
      id: 'r1',
      muxName: 'mux-r1',
      repoName: 'a',
      repoPath: home,
      home,
      worktree: 'feat',
      worktreePath: wt,
      branch: 'feature/feat',
      settingsFile: '/tmp/r1.settings.json',
      repos: [sessionRepo({ repo: 'a', primary: true })],
      claudeSessionId: 'sid-1',
      active: false,
      state: 'stopped',
      createdAt: Date.now(),
    }),
  );

  await m.activate('r1');
  assert.equal(
    cwd,
    home,
    'resume launches from home (the transcript dir) so --resume resolves the conversation',
  );

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(wt, { recursive: true, force: true });
});

test('restore flags a promoted session whose worktree dir is gone instead of faking a resume', async () => {
  const m = manager();
  const ensured: string[] = [];
  m.mux = muxStub({
    async ensure(n) {
      ensured.push(n);
      return {};
    },
  });
  m.sessions.set(
    'g1',
    session({
      id: 'g1',
      muxName: 'mux-g1',
      repoPath: '/tmp/gone',
      home: '/tmp/gone',
      worktree: 'feat',
      worktreePath: '/tmp/does-not-exist-wts-xyz',
      branch: 'feature/feat',
      claudeSessionId: 'sid-1',
      active: true,
      state: 'idle',
      createdAt: Date.now(),
    }),
  );

  const n = await m.restore();
  assert.equal(n, 0, 'a session with a missing worktree is not counted as restored');
  assert.equal(ensured.length, 0, 'mux.ensure is not called for a missing worktree');
  const s = got(m, 'g1');
  assert.equal(s.state, 'stopped');
  assert.equal(s.activity, 'worktree missing');
});

test('tmux sendText sends the body literally (-l) then submits with a separate Enter', async (t) => {
  if (!(await tmux.available())) {
    t.skip('tmux not installed');
    return;
  }
  const name = `wts-test-sendtext-${Date.now().toString(36)}`;
  const outFile = path.join(os.tmpdir(), `${name}.txt`);
  // `cat > file` writes each submitted line to the file; a literal send must land
  // tokens like `Enter`/`;` verbatim (an interpreted send would fire real keys).
  await tmux.ensure(name, { cwd: os.tmpdir(), cmd: `cat > ${shq(outFile)}` });
  try {
    /*
     * Wait for `cat` to become the pane's foreground program.
     *
     * 15s, not 5s. This drives a REAL tmux, and the budget has to cover the worst case
     * rather than the typical one: it passed alone and failed inside the full suite,
     * where several hundred other tests are competing for the machine. A poll loop exits
     * as soon as the condition holds, so a longer ceiling costs a healthy run nothing and
     * only buys headroom for a loaded one.
     */
    for (let i = 0; i < 150 && (await tmux.paneCommand(name)) !== 'cat'; i++)
      await new Promise((r) => setTimeout(r, 100));
    const literal = 'echo hi; Enter Space done';
    await tmux.sendText(name, literal);
    let got = '';
    for (let i = 0; i < 150; i++) {
      got = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
      if (got.includes('done')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(got.trim(), literal, 'the exact literal string (incl. `;`/`Enter`) was delivered');
  } finally {
    await tmux.kill(name);
    fs.rmSync(outFile, { force: true });
    /*
     * Remove the launch script this created.
     *
     * This test drives the REAL tmux, so tmux.ensure() → launchKeys() writes into the
     * real CONFIG_DIR — tmux.ts resolves it at module load, and a static import is
     * hoisted above any env var this file could set. So every `npm test` used to leak
     * one file into ~/.config/worktree-studio/launch/, which is most of what had
     * accumulated there. The boot reaper would clear them within a day; not creating
     * them is better.
     */
    fs.rmSync(path.join(CONFIG_DIR, 'launch', `${name}-0.sh`), { force: true });
  }
});

test('promote returns needsConfirm when the main checkout is dirty, and does not promote', async () => {
  const m = manager();
  const repo = tempRepo('dirty');
  fs.writeFileSync(path.join(repo, 'README.md'), '# uncommitted change\n'); // dirty the main checkout
  m.sessions.set(
    'd1',
    session({
      id: 'd1',
      repoName: 'a',
      repoPath: repo,
      home: repo,
      worktree: null,
      worktreePath: null,
      branch: null,
      feature: 'orig',
      suggestedBranch: 'feature/x',
      suggestedName: 'x',
      muxName: 'mux-d1',
      pendingRepos: [],
      repos: [sessionRepo({ repo: 'a', repoPath: repo, primary: true })],
      state: 'idle',
      active: true,
      createdAt: Date.now(),
    }),
  );

  const out = await m.promote('d1');
  assert.equal(out.ok, false);
  assert.equal(out.needsConfirm, true);
  assert.ok(
    present(out.dirty, 'the dirty list').some((f) => /README\.md/.test(f)),
    `expected README in dirty list: ${JSON.stringify(out.dirty)}`,
  );
  assert.equal(got(m, 'd1').worktreePath, null, 'session is not promoted while unconfirmed');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('promote with confirm:true proceeds past a dirty main and creates the worktree', async () => {
  const m = manager();
  const repo = tempRepo('dirty-confirm');
  fs.writeFileSync(path.join(repo, 'README.md'), '# uncommitted change\n');
  m.sessions.set(
    'd2',
    session({
      id: 'd2',
      repoName: 'a',
      repoPath: repo,
      home: repo,
      worktree: null,
      worktreePath: null,
      branch: null,
      feature: 'orig',
      suggestedBranch: 'feature/x',
      suggestedName: 'x',
      muxName: 'mux-d2',
      pendingRepos: [],
      repos: [sessionRepo({ repo: 'a', repoPath: repo, primary: true })],
      state: 'idle',
      active: true,
      createdAt: Date.now(),
    }),
  );

  const out = await m.promote('d2', { confirm: true });
  expectOk(out);
  assert.ok(got(m, 'd2').worktreePath, 'promoted after confirm');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('reconcile flips a session whose mux session vanished to stopped and leaves a live one alone', async () => {
  const m = manager();
  m.mux = muxStub({
    async hasSession(n) {
      return n === 'live-mux';
    },
  });
  m.sessions.set(
    'dead',
    session({ id: 'dead', muxName: 'dead-mux', state: 'idle', active: true, createdAt: Date.now() }),
  );
  m.sessions.set(
    'live',
    session({ id: 'live', muxName: 'live-mux', state: 'working', active: true, createdAt: Date.now() }),
  );

  await m.reconcile();

  const dead = got(m, 'dead');
  assert.equal(dead.state, 'stopped');
  assert.equal(dead.active, false);
  assert.equal(dead.activity, 'session ended');
  const live = got(m, 'live');
  assert.equal(live.state, 'working', 'a live session is left untouched');
  assert.equal(live.active, true);
});

test('reconcile leaves an already-stopped session untouched (no redundant flip)', async () => {
  const m = manager();
  let queried = 0;
  m.mux = muxStub({
    async hasSession() {
      queried++;
      return false;
    },
  });
  m.sessions.set(
    's1',
    session({
      id: 's1',
      muxName: 'm',
      state: 'stopped',
      active: false,
      activity: 'deactivated',
      createdAt: Date.now(),
    }),
  );

  await m.reconcile();

  assert.equal(queried, 0, 'does not even query the mux for a stopped/deactivated session');
  assert.equal(got(m, 's1').activity, 'deactivated', 'activity is not overwritten');
});

// adopt launches claude in the worktree, so that's where the transcript lives —
// home must equal it or --resume (which resumes from home) can't find the conversation.
test('adopt sets home to the worktree launch dir (so resume resolves the conversation)', async () => {
  const m = manager();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-adopt-home-'));
  const s = await m.adopt({
    worktreePath: wt,
    repoName: 'r',
    repoPath: '/tmp/r',
    branch: 'b',
    wtname: 'feat',
  });
  assert.ok(s?.id, 'session adopted');
  assert.equal(s.home, wt, 'home is the worktree (launch/transcript dir), not repoPath');
  fs.rmSync(wt, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// session.feature is the feature IDENTITY, not the worktree name
//
// `POST /group/pr { group: session.feature }` (public/app.js) resolves that value
// against the feature names state.ts computes with server/identity.ts. Under
// `basename` the identity and the worktree name coincide, which is why storing the
// name was latent; under `branch`/`manifest` they differ and the lookup 404s.
// ---------------------------------------------------------------------------
import { createIdentity } from '../server/identity.ts';
import tmux from '../server/multiplexer/tmux.ts';
import { computeFeatures } from '../server/features.ts';

// Group `fix/4821-payments` and `feat/4821-ui` both onto the ticket number 4821.
const BY_TICKET: PartialDeep<Config> = {
  featureIdentity: { strategy: 'branch', branchPattern: '^(?:fix|feat|feature)/(\\d+)' },
};

test('promote stores the feature identity, and still NAMES the worktree by name', async () => {
  const m = manager(BY_TICKET);
  const repo = tempRepo('ident-promote');
  m.sessions.set(
    'i1',
    session({
      id: 'i1',
      repoName: 'api',
      repoPath: repo,
      home: repo,
      worktree: null,
      worktreePath: null,
      branch: null,
      feature: 'placeholder',
      suggestedBranch: 'fix/4821-payments',
      suggestedName: 'payments',
      muxName: 'mux-i1',
      pendingRepos: [],
      repos: [sessionRepo({ repo: 'api', repoPath: repo, primary: true })],
      state: 'idle',
      active: true,
      createdAt: Date.now(),
    }),
  );

  const out = await m.promote('i1');
  expectOk(out);
  const s = got(m, 'i1');

  // naming is untouched — the directory is still the worktree name
  assert.equal(s.worktree, 'payments');
  assert.ok(
    fs.existsSync(path.join(repo, '.worktrees', 'payments')),
    'worktree dir is named after the worktree',
  );
  // grouping is the identity
  assert.equal(s.feature, '4821', 'the stored feature is the identity the branch strategy resolves');

  // …and that value is exactly what a /group/* lookup would find.
  const identity = createIdentity(BY_TICKET);
  // Only the four fields the `branch` identity strategy reads.
  const wt = { repo: 'api', wtname: s.worktree, branch: s.branch, path: s.worktreePath } as Worktree;
  const { features } = computeFeatures([wt], [], identity);
  assert.ok(
    features.some((f) => f.name === s.feature),
    `no feature named ${s.feature} in ${features.map((f) => f.name).join(', ')}`,
  );

  fs.rmSync(repo, { recursive: true, force: true });
});

test('adopt stores the identity of the worktree it adopted', async () => {
  const m = manager(BY_TICKET);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-ident-adopt-'));
  const s = present(
    await m.adopt({
      worktreePath: wt,
      repoName: 'api',
      repoPath: '/tmp/api',
      branch: 'feat/4821-ui',
      wtname: 'ui-work',
    }),
    'the adopted session',
  );
  assert.equal(s.worktree, 'ui-work', 'the worktree keeps its own name');
  assert.equal(s.feature, '4821', 'the session records the identity, not the name');
  fs.rmSync(wt, { recursive: true, force: true });
});

test('addRepo names the sibling worktree after the worktree, never after the identity', async () => {
  // The identity here is `4821` — a ticket number, not a directory name. Creating
  // `<repo>/.worktrees/4821` would be a silent renaming of the user's worktrees.
  const m = manager(BY_TICKET);
  const repoB = tempRepo('ident-addrepo');
  m.sessions.set(
    'i2',
    session({
      id: 'i2',
      feature: '4821',
      worktree: 'payments',
      branch: 'fix/4821-payments',
      muxName: 'mux-i2',
      repos: [
        sessionRepo({
          repo: 'api',
          repoPath: '/tmp/api',
          worktree: 'payments',
          worktreePath: '/tmp/api/.worktrees/payments',
          primary: true,
        }),
      ],
    }),
  );
  const out = await m.addRepo('i2', { repo: 'fe', repoPath: repoB });
  expectOk(out);
  assert.ok(
    fs.existsSync(path.join(repoB, '.worktrees', 'payments')),
    "sibling worktree keeps the feature's worktree name",
  );
  assert.ok(
    !fs.existsSync(path.join(repoB, '.worktrees', '4821')),
    'the grouping key was not used as a directory name',
  );
  fs.rmSync(repoB, { recursive: true, force: true });
});

test('a session persisted before worktree name and identity were told apart still names siblings', async () => {
  // Back-compat: old sessions.json rows carry `feature` and nothing else naming-ish.
  const m = manager();
  const repoB = tempRepo('ident-legacy');
  // Spelled out, not left to the fixture: this test IS about the fields an old row
  // does NOT have. worktreeNameFor() reads worktree → primary.worktree → suggestedName
  // → feature, so both earlier keys have to be empty for the fallback to be exercised.
  m.sessions.set(
    'old',
    session({
      id: 'old',
      feature: 'legacy-feat',
      branch: 'feature/legacy-feat',
      muxName: 'mux-old',
      worktree: null,
      suggestedName: '',
      repos: [sessionRepo({ repo: 'api', repoPath: '/tmp/api', primary: true })],
    }),
  );
  const out = await m.addRepo('old', { repo: 'fe', repoPath: repoB });
  expectOk(out);
  assert.ok(
    fs.existsSync(path.join(repoB, '.worktrees', 'legacy-feat')),
    'falls back to the stored feature exactly as before',
  );
  fs.rmSync(repoB, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// restore()
// ---------------------------------------------------------------------------

// Three restorable sessions in a known order (all() sorts newest-first).
function restorable(m: SessionManager, ids: string[]): void {
  const dir = present(m.cfg._stateDir, 'the state dir');
  // A block body, not an expression: `Map.set` returns the Map, and an arrow that
  // hands a value back to forEach reads as though the value is used.
  ids.forEach((id, i) => {
    m.sessions.set(
      id,
      session({
        id,
        title: id,
        repoName: 'api',
        repoPath: dir,
        home: dir,
        feature: id,
        repos: [sessionRepo({ repo: 'api', repoPath: dir, primary: true })],
        muxName: `mux-${id}`,
        tabs: [{ id: '0', title: 'claude' }],
        state: 'idle',
        active: true,
        createdAt: ids.length - i,
      }),
    );
  });
}

test('restore() carries on past a session it cannot relaunch, and still saves', async () => {
  const m = manager();
  restorable(m, ['a', 'b', 'c']);
  const launched: string[] = [];
  m.mux.ensure = async (name: string) => {
    launched.push(name);
    return {};
  };
  // _writeHookSettings is a mkdirSync + writeFileSync — an EACCES or a full disk
  // throws right here, which is the failure this guard exists for.
  const real = m._writeHookSettings.bind(m);
  m._writeHookSettings = (s: Session) => {
    if (s.id === 'b') throw new Error('EACCES: permission denied');
    return real(s);
  };

  const n = await m.restore();

  assert.equal(n, 2, 'the two healthy sessions were relaunched');
  assert.deepEqual(launched, ['mux-a', 'mux-c'], 'the session AFTER the failure was still reached');
  assert.equal(got(m, 'b').state, 'stopped');
  assert.match(
    got(m, 'b').activity,
    /restore failed: EACCES/,
    'the failure is recorded on the session itself',
  );
  assert.equal(got(m, 'c').activity, 'restarted');
  // _save() must still run, or the on-disk state keeps claiming everything is fine.
  // Read through loadSessions rather than JSON.parse: the file is a versioned envelope
  // now, and a test that reaches past the module owning that shape would break on the
  // next migration for no reason of its own.
  const saved: Session[] = loadSessions(m.file).sessions;
  const savedBy = (id: string) =>
    present(
      saved.find((x) => x.id === id),
      `saved session ${id}`,
    );
  assert.equal(savedBy('b').state, 'stopped');
  assert.equal(savedBy('c').activity, 'restarted');
});

test('restore() reports a count that a caller can distinguish from failure', async () => {
  const m = manager();
  restorable(m, ['a']);
  assert.equal(await m.restore(), 1);
  const empty = manager();
  assert.equal(
    await empty.restore(),
    0,
    'no sessions is still 0 — the difference has to come from the throw',
  );
});

/*
 * Resume on a session whose tmux outlived its agent.
 *
 * This is the ordinary end state of an agent: claude exits, the launch script's
 * `exec zsh -l` keeps the window, and the tmux session is still there. `ensure` is
 * create-if-missing, so it truthfully answered "already there" and started nothing —
 * and the button did nothing, over and over, while reporting success.
 */
test('activate restarts the agent when the session exists but the agent has exited', async () => {
  const m = manager();
  const relaunched: Array<{ tabId?: string | null; cmd?: string }> = [];
  m.mux = muxStub({
    async ensure() {
      return { created: false }; // the session is already there
    },
    async relaunchAgent(_n, opts) {
      relaunched.push({ tabId: opts?.tabId, cmd: opts?.cmd });
      return { ok: true, id: '@42' };
    },
  });
  m.sessions.set(
    'r1',
    session({
      id: 'r1',
      muxName: 'mux-r1',
      repoPath: '/tmp/r',
      home: '/tmp/r',
      worktreePath: null,
      settingsFile: '/tmp/r1.settings.json',
      repos: [sessionRepo({ repo: 'r', primary: true })],
      claudeSessionId: 'sid-r',
      agentTabId: '@2',
      active: false,
      state: 'stopped',
      createdAt: Date.now(),
    }),
  );

  expectOk(await m.activate('r1'), 'activate()');
  assert.equal(relaunched.length, 1, 'the agent is relaunched rather than assumed running');
  assert.equal(relaunched[0]?.tabId, '@2', 'the old window is offered for reuse');
  assert.ok(relaunched[0]?.cmd?.includes('-r '), 'and it resumes the conversation');
  assert.equal(got(m, 'r1').agentTabId, '@42', 'the new window id replaces the stale one');
  assert.equal(got(m, 'r1').state, 'idle');
});

/*
 * The stale-id half. `agentTabId` was learned once and never again, so a session whose
 * tmux was recreated carried an id no live window had. The liveness check compares the
 * two, so it declared a healthy agent exited — every few seconds, forever.
 */
test('activate records the agent window id the launch reports', async () => {
  const m = manager();
  m.mux = muxStub({
    async ensure() {
      return { created: true, id: '@9' };
    },
  });
  m.sessions.set(
    'r2',
    session({
      id: 'r2',
      muxName: 'mux-r2',
      repoPath: '/tmp/r2',
      home: '/tmp/r2',
      worktreePath: null,
      settingsFile: '/tmp/r2.settings.json',
      repos: [sessionRepo({ repo: 'r2', primary: true })],
      agentTabId: '@2', // stale: from the session this one replaces
      active: false,
      state: 'stopped',
      createdAt: Date.now(),
    }),
  );

  expectOk(await m.activate('r2'), 'activate()');
  assert.equal(got(m, 'r2').agentTabId, '@9');
});

test('a relaunch that fails leaves the session stopped, not idle', async () => {
  const m = manager();
  m.mux = muxStub({
    async ensure() {
      return { created: false };
    },
    async relaunchAgent() {
      return { ok: false, error: 'no server running' };
    },
  });
  m.sessions.set(
    'r3',
    session({
      id: 'r3',
      muxName: 'mux-r3',
      repoPath: '/tmp/r3',
      home: '/tmp/r3',
      worktreePath: null,
      settingsFile: '/tmp/r3.settings.json',
      repos: [sessionRepo({ repo: 'r3', primary: true })],
      active: false,
      state: 'stopped',
      createdAt: Date.now(),
    }),
  );

  const r = await m.activate('r3');
  assert.equal(r.ok, false, 'the failure is reported');
  assert.equal(got(m, 'r3').state, 'stopped');
  assert.match(got(m, 'r3').activity, /no server running/);
});

/*
 * A session that was running all along and only LOOKED dead, because its recorded
 * window id was stale. Resume must adopt the live agent, not start a second one into
 * the same tmux session — two claudes resuming one conversation is a worse outcome
 * than the wrong badge that sent you to the button.
 */
test('activate adopts an agent that is already running instead of launching a second one', async () => {
  const m = manager();
  let launches = 0;
  m.mux = muxStub({
    async ensure() {
      return { created: false };
    },
    async relaunchAgent() {
      return { ok: true, id: '@5', running: true }; // found it alive
    },
    async newTab() {
      launches += 1;
      return { ok: true };
    },
  });
  m.sessions.set(
    'r4',
    session({
      id: 'r4',
      muxName: 'mux-r4',
      repoPath: '/tmp/r4',
      home: '/tmp/r4',
      worktreePath: null,
      settingsFile: '/tmp/r4.settings.json',
      repos: [sessionRepo({ repo: 'r4', primary: true })],
      claudeSessionId: 'sid-r4',
      agentTabId: '@2', // stale
      active: false,
      state: 'stopped',
      createdAt: Date.now(),
    }),
  );

  expectOk(await m.activate('r4'), 'activate()');
  assert.equal(launches, 0, 'nothing was launched');
  assert.equal(got(m, 'r4').agentTabId, '@5', 'the live window id is recorded');
  assert.equal(got(m, 'r4').state, 'idle');
  assert.equal(got(m, 'r4').activity, 'already running', 'and it does not claim to have resumed anything');
});
