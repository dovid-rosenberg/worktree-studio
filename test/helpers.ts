// Shared fixtures and narrowing assertions for the suite.
//
// Not a test file (no `.test.ts`), so `node --test test/*.test.ts` never runs it —
// but it IS inside tsconfig's `include`, which is the point: the defaults below have
// to satisfy the real interfaces, so a contract that grows a member breaks HERE, in
// one place, instead of in thirty test files or, worse, in nothing at all.
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import type { Session, SessionRepo } from '../server/types.ts';
import type { SessionMux } from '../server/sessions.ts';

// ---- environment gates ------------------------------------------------------

/**
 * Skip the calling test when there is no tmux to drive. Returns true when it skipped,
 * so the caller's first line can be `if (await requireTmux(t)) return;`.
 *
 * Every test that spawns a real tmux session has to go through here rather than writing
 * its own probe. CI's comment already claimed "a handful of tests skip themselves when
 * tmux is absent" while exactly one of them did; the rest would have failed on a machine
 * without it, and the failure reads as a broken multiplexer rather than a missing binary.
 *
 * Deliberately does NOT import the tmux driver to ask it: that module writes tmux.conf
 * into CONFIG_DIR at evaluation, and helpers.ts is imported by most of the suite.
 */
export function requireTmux(t: { skip(message?: string): void }): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tmux', ['-V'], (err) => {
      if (err) t.skip('tmux not installed');
      resolve(!!err);
    });
  });
}

// ---- narrowing assertions ---------------------------------------------------
//
// `assert.ok()` is declared `asserts value`, so `assert.ok(r.ok)` narrows a
// discriminated union on its own and most call sites need nothing more. These two
// exist for the case that motivated them: reporting WHAT went wrong. The failure
// branch's `error` cannot be read before the union is narrowed, so
// `assert.equal(r.ok, true, r.error)` — what these tests used to say — does not
// type-check and never narrowed anything either.

// `Extract` collapses to `never` when the value is NOT a discriminated union (an
// `{ ok: boolean }` with optional everything). Falling back to `T` keeps a mis-modelled
// result readable instead of turning every field access into an error about `never`,
// which says nothing about what is actually wrong.
type OkOf<T> = [Extract<T, { ok: true }>] extends [never] ? T : Extract<T, { ok: true }>;
type ErrOf<T> = [Extract<T, { ok: false }>] extends [never] ? T : Extract<T, { ok: false }>;

/** Assert the success branch was taken, and narrow to it. Reports the whole value on failure. */
export function expectOk<T extends { ok: boolean }>(r: T, what = 'call'): OkOf<T> {
  assert.ok(r.ok, `${what} failed: ${JSON.stringify(r)}`);
  // The one cast in the suite, and it is guarded by the line above.
  return r as OkOf<T>;
}

/** Assert the failure branch was taken, and narrow to it (that is the one carrying `error`). */
export function expectErr<T extends { ok: boolean }>(r: T, what = 'call'): ErrOf<T> {
  assert.ok(!r.ok, `${what} unexpectedly succeeded: ${JSON.stringify(r)}`);
  return r as ErrOf<T>;
}

/** A `find()` / `Map.get()` that the test requires to hit. */
export function present<T>(v: T | null | undefined, what = 'value'): T {
  assert.ok(v !== null && v !== undefined, `expected a ${what}, got ${v}`);
  return v;
}

/**
 * A parsed HTTP JSON body.
 *
 * `any` deliberately, and it is the only `any` in the suite: a response body has no
 * compile-time shape — `Response.json()` is typed `unknown` for exactly that reason —
 * and every use is an assertion ABOUT its runtime value. Narrowing each read would
 * add noise to the assertion without adding a check, since the assertion is the check.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonBody = any;

/** `res.json()` as a body the assertions can read. */
export async function body(res: Response): Promise<JsonBody> {
  return res.json();
}

// ---- fixtures ---------------------------------------------------------------

/**
 * A complete `Session`. Tests spell only the fields they assert on; everything else
 * takes a neutral default, so a new REQUIRED field on `Session` is added once here
 * rather than in every test that stores one.
 *
 * CAVEAT, and it has bitten once already: a test about a FALLBACK must clear the
 * earlier fields explicitly. `worktreeNameFor()` reads worktree → primary.worktree →
 * suggestedName → feature, and the defaults below fill `suggestedName`, so a test
 * that means "an old row carries nothing but `feature`" has to say
 * `suggestedName: ''` or it silently stops testing the fallback.
 */
export function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'a session',
    source: 'freetext',
    sourceId: null,
    sourceUrl: null,
    repoName: 'api',
    repoPath: '/code/api',
    home: '/code/api',
    worktree: null,
    worktreePath: null,
    branch: null,
    feature: 'a-session',
    repos: [],
    pendingRepos: [],
    suggestedBranch: null,
    suggestedName: 'a-session',
    muxName: 'wts-a-session-0001',
    claudeSessionId: null,
    state: 'idle',
    activity: '',
    tabs: [],
    seed: null,
    active: true,
    createdAt: 1_700_000_000_000,
    promotedAt: null,
    ...over,
  };
}

/** One repo a session spans, complete. Worktree fields stay null until promote(). */
export function sessionRepo(over: Partial<SessionRepo> = {}): SessionRepo {
  return { repo: 'api', repoPath: '/code/api', worktree: null, worktreePath: null, branch: null, ...over };
}

/**
 * A complete multiplexer driver that does nothing.
 *
 * Overriding is how a test says what it cares about — `muxStub({ async hasSession() { return true; } })`.
 * The base has to satisfy `SessionMux` in full, which is what makes a member added to
 * that interface (as `ensureSplit` and `attachSpawn` recently were) a compile error
 * here instead of an untyped hole in every double.
 */
export function muxStub(over: Partial<SessionMux> = {}): SessionMux {
  return {
    name: 'stub',
    async ensure() {
      return {};
    },
    async relaunchAgent() {
      return { ok: true };
    },
    async hasSession() {
      return false;
    },
    async kill() {
      return true;
    },
    async rename() {
      return false;
    },
    async sendText() {
      return undefined;
    },
    async paneCommand() {
      return 'node';
    },
    async paneCwd() {
      return '';
    },
    async newTab() {
      return { ok: true };
    },
    async listTabs() {
      return [];
    },
    async selectTab() {
      return true;
    },
    async closeTab() {
      return true;
    },
    async renameTab() {
      return true;
    },
    attachSpawn(name: string) {
      return { file: 'true', args: [name] };
    },
    ...over,
  };
}
