import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { SessionManager } from '../server/sessions.ts';
import type { Config, PartialDeep, Session } from '../server/types.ts';
import { muxStub, present, session, sessionRepo } from './helpers.ts';

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

function manager() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-state-'));
  const cfg: PartialDeep<Config> = {
    _stateDir: stateDir,
    _file: path.join(stateDir, 'config.json'),
    web: { port: 0 },
    claude: { cmd: 'claude' },
    baseDirs: [],
    copyPatterns: {},
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

test('sessionForWorktree finds a session by ANY of its repos worktreePaths', () => {
  const m = manager();
  m.sessions.set(
    's1',
    session({
      id: 's1',
      worktreePath: '/x/primary',
      repos: [
        sessionRepo({ repo: 'a', worktreePath: '/x/primary', primary: true }),
        sessionRepo({ repo: 'b', worktreePath: '/y/sibling', primary: false }),
      ],
    }),
  );
  assert.equal(present(m.sessionForWorktree('/x/primary')).id, 's1');
  assert.equal(present(m.sessionForWorktree('/y/sibling')).id, 's1', 'finds by a non-primary repo');
  assert.equal(m.sessionForWorktree('/nope'), null);
});

// The lookup topology() used to do per worktree: scan every session, resolving
// every path it owns, and take the first match. sessionIndex() replaced N of
// these with one pass, so it has to answer identically — including for a session
// that owns several repos' worktrees, and for symlinked spellings of a path.
function scanForWorktree(sessions: Session[], worktreePath: string): Session | null {
  const norm = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const target = norm(worktreePath);
  for (const s of sessions) {
    if (s.worktreePath && norm(s.worktreePath) === target) return s;
    if ((s.repos || []).some((r) => r.worktreePath && norm(r.worktreePath) === target)) return s;
  }
  return null;
}

test('sessionIndex answers exactly like the per-worktree scan it replaced', () => {
  // Real dirs plus a symlinked alias, so resolution actually has work to do.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wts-idx-')));
  const real = (n: string) => {
    const p = path.join(root, n);
    fs.mkdirSync(p);
    return p;
  };
  const primary = real('primary');
  const sibling = real('sibling');
  const lone = real('lone');
  const gone = path.join(root, 'never-existed');
  const alias = path.join(root, 'alias');
  fs.symlinkSync(sibling, alias); // another spelling of the sibling worktree

  const m = manager();
  const s1 = session({
    id: 's1',
    worktreePath: primary,
    repos: [
      sessionRepo({ repo: 'a', worktreePath: primary, primary: true }),
      sessionRepo({ repo: 'b', worktreePath: alias, primary: false }), // stored under the symlink
    ],
  });
  const s2 = session({
    id: 's2',
    worktreePath: lone,
    repos: [sessionRepo({ repo: 'c', worktreePath: lone, primary: true })],
  });
  const s3 = session({
    id: 's3',
    worktreePath: null,
    repos: [sessionRepo({ repo: 'd', worktreePath: null, primary: true })],
  }); // unpromoted
  for (const s of [s1, s2, s3]) m.sessions.set(s.id, s);

  const index = m.sessionIndex();
  const norm = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const sessions = [s1, s2, s3];
  for (const p of [primary, sibling, alias, lone, gone, root]) {
    assert.equal(
      index.get(norm(p)) || null,
      scanForWorktree(sessions, p),
      `same answer for ${path.basename(p)}`,
    );
  }
  // and the answers are the ones that matter, not two matching nulls
  assert.equal(
    present(index.get(sibling)).id,
    's1',
    'a multi-repo session is found by a sibling repo worktree',
  );
  assert.equal(present(index.get(primary)).id, 's1');
  assert.equal(present(index.get(lone)).id, 's2');
  assert.equal(index.get(gone), undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('sessionForWorktree still resolves symlinks and is first-match-wins', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wts-idx2-')));
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(wt, alias);
  const m = manager();
  m.sessions.set('first', session({ id: 'first', worktreePath: wt, repos: [] }));
  m.sessions.set('second', session({ id: 'second', worktreePath: alias, repos: [] })); // same worktree, other spelling
  assert.equal(
    present(m.sessionForWorktree(alias)).id,
    'first',
    'the symlinked spelling finds the session stored under the real path',
  );
  assert.equal(present(m.sessionForWorktree(wt)).id, 'first', 'the earlier session wins a duplicate claim');
  // A path a caller may genuinely not have — an unpromoted session's worktreePath.
  assert.equal(m.sessionForWorktree(null as unknown as string), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('addRepo creates a same-named sibling worktree, tracks it, and grants /add-dir access', async () => {
  const m = manager();
  const repoB = tempRepo('b');
  m.sessions.set(
    's2',
    session({
      id: 's2',
      feature: 'shared-feat',
      branch: 'feature/shared-feat',
      muxName: 'mux2',
      repos: [
        sessionRepo({
          repo: 'a',
          repoPath: '/tmp/a',
          worktree: 'shared-feat',
          worktreePath: '/tmp/a/.worktrees/shared-feat',
          branch: 'feature/shared-feat',
          primary: true,
        }),
      ],
    }),
  );
  const out = await m.addRepo('s2', { repo: 'b', repoPath: repoB });
  assert.ok(out.ok, `addRepo failed: ${JSON.stringify(out)}`);
  // sibling worktree created with the SAME name as the feature (→ auto-groups)
  const wtPath = path.join(repoB, '.worktrees', 'shared-feat');
  assert.ok(fs.existsSync(wtPath), 'sibling worktree exists');
  // tracked on the session
  const s = present(m.get('s2'), 'session s2');
  assert.equal(s.repos.length, 2);
  assert.equal(s.repos[1].repo, 'b');
  assert.equal(s.repos[1].worktreePath, wtPath);
  // live access granted via /add-dir
  assert.ok(
    m._sent.some((t) => t === `/add-dir ${wtPath}`),
    'sent /add-dir to the session',
  );
  // and findable
  assert.equal(present(m.sessionForWorktree(wtPath)).id, 's2');
  fs.rmSync(repoB, { recursive: true, force: true });
});

test('addRepo is idempotent for a repo already in the feature', async () => {
  const m = manager();
  m.sessions.set(
    's3',
    session({
      id: 's3',
      feature: 'f',
      branch: 'feature/f',
      muxName: 'm3',
      repos: [sessionRepo({ repo: 'a', repoPath: '/tmp/a', primary: true })],
    }),
  );
  const out = await m.addRepo('s3', { repo: 'a', repoPath: '/tmp/a' });
  assert.equal('already' in out && out.already, true);
  assert.equal(present(m.get('s3'), 'session s3').repos.length, 1);
});

test('restore() leaves a deactivated session stopped and does not relaunch it', async () => {
  const m = manager();
  const ensured: string[] = [];
  m.mux = muxStub({
    async ensure(n) {
      ensured.push(n);
      return {};
    },
  });
  m.sessions.set(
    'd1',
    session({ id: 'd1', muxName: 'mux-d1', active: false, state: 'stopped', createdAt: 1 }),
  );
  const n = await m.restore();
  assert.equal(n, 0, 'nothing restored');
  assert.equal(ensured.length, 0, 'mux.ensure not called for a deactivated session');
  assert.equal(present(m.get('d1'), 'session d1').state, 'stopped');
});

/*
 * ATTACHING AN EXISTING SIBLING RECORDS THE BRANCH IT IS ON.
 *
 * addRepo's happy path creates the worktree, so the branch it asked for is the branch
 * that exists. The already-exists path is different: nothing was created, and
 * `worktree.create()`'s result carries the branch it INTENDED — derived from the
 * session's own branch. The two differ exactly when the sibling was made outside Studio,
 * which is the only situation this path ever runs in. A real case: the backend on
 * `feature/merchant-mfa-totp`, the frontend worktree of the same feature on
 * `feature/mfa-totp`.
 *
 * Recording the intended one is not cosmetic. ci.ts looks a merge request up by
 * worktree+branch, so the newly attached repo reports "no MR" for a branch that has one —
 * the very symptom attaching is supposed to cure — and review.base() diffs against a
 * branch the worktree is not on.
 */
test('attaching an existing sibling records the branch on disk, not the one create() wanted', async () => {
  const m = manager();
  const repoB = tempRepo('b');
  // The sibling already exists, on a DIFFERENT branch — made with `wt`, outside Studio.
  const wtPath = path.join(repoB, '.worktrees', 'shared-feat');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature/fe-only', wtPath], { cwd: repoB });

  m.sessions.set(
    's4',
    session({
      id: 's4',
      feature: 'shared-feat',
      branch: 'feature/shared-feat',
      muxName: 'mux4',
      repos: [
        sessionRepo({
          repo: 'a',
          repoPath: '/tmp/a',
          worktree: 'shared-feat',
          worktreePath: '/tmp/a/.worktrees/shared-feat',
          branch: 'feature/shared-feat',
          primary: true,
        }),
      ],
    }),
  );

  const out = await m.addRepo('s4', { repo: 'b', repoPath: repoB });
  assert.ok(out.ok, `addRepo failed: ${JSON.stringify(out)}`);
  assert.ok(out.attached, 'the existing worktree was attached, not created');

  const s = present(m.get('s4'), 'session s4');
  const added = present(
    s.repos.find((r) => r.repo === 'b'),
    'the attached repo',
  );
  assert.equal(added.worktreePath, wtPath);
  assert.equal(
    added.branch,
    'feature/fe-only',
    'the branch the worktree is on, not the one addRepo was going to create',
  );
  assert.ok(
    m._sent.some((t) => t === `/add-dir ${wtPath}`),
    'the live session was granted access',
  );
  fs.rmSync(repoB, { recursive: true, force: true });
});
