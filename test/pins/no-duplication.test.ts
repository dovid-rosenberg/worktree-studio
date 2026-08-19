/*
 * Rules that must have exactly ONE implementation.
 *
 * This codebase's recurring failure is not bad code — it is the same rule written in
 * several places, where the copies then drift and one of them becomes wrong. It has
 * happened enough times to be worth a test rather than a resolution:
 *
 *   - "release a concurrency slot" existed three times with three different guards; two
 *     leaked ports.
 *   - "what did this batch of launches achieve" existed twice; only one copy was fixed,
 *     so a different button reproduced a closed bug.
 *   - "the repo's default branch" existed three times and the copies disagreed on both
 *     the `origin/` prefix and the fallback.
 *   - the Homebrew PATH prelude existed in six modules, and `has()` used NONE of them —
 *     so Studio probed for a CLI under one PATH and ran it under another.
 *
 * A grep test is crude, but it fails at the moment a seventh copy is pasted in, which is
 * the only moment anyone can cheaply stop it.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const ROOT = new URL('../..', import.meta.url).pathname;

function serverFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(path.join(ROOT, 'server'));
  return out;
}

/** Every client source the UI is built from — `.ts` and `.svelte`, tests excluded. */
function clientFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|svelte)$/.test(e.name) && !e.name.includes('.test.')) out.push(full);
    }
  };
  walk(path.join(ROOT, 'client', 'src'));
  return out;
}

/** Files containing a pattern, as repo-relative paths. */
function containing(re: RegExp, files: string[] = serverFiles()): string[] {
  return files
    .filter((f) => re.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f))
    .sort();
}

test('the child-process PATH prelude is defined in exactly one place', () => {
  // Six modules had their own copy. The literal may appear ONLY in util.ts, which is
  // where CHILD_ENV lives; everyone else imports it.
  assert.deepEqual(
    containing(/\/opt\/homebrew\/bin/),
    ['server/util.ts'],
    'import CHILD_ENV from util.ts instead of pasting the PATH prelude',
  );
});

test('the origin/HEAD lookup is written in exactly one place', () => {
  // git.ts owns it and exports three named forms, because the callers genuinely differ:
  // originHead (raw, '' when absent), defaultBranch (bare name, guessed), defaultBase
  // (keeps `origin/` so a new worktree starts from the remote tip).
  assert.deepEqual(
    containing(/refs\/remotes\/origin\/HEAD/),
    ['server/git.ts'],
    'use originHead / defaultBranch / defaultBase from git.ts',
  );
});

test("a dev server's URL is built in exactly one place, and never from an IP literal", () => {
  /*
   * There were two builders and they disagreed: `openApp` opened `http://localhost:${port}`
   * while DockHead's port chip — the one you actually click — linked
   * `http://127.0.0.1:${port}`.
   *
   * That is not a cosmetic difference. Vite and friends bind loopback by FAMILY, and on a
   * modern Node that is frequently `[::1]` alone, so the IPv4 literal is refused by a
   * server that is running perfectly well:
   *
   *     node ... TCP [::1]:3031 (LISTEN)
   *     curl http://127.0.0.1:3031/  → connection refused
   *     curl http://localhost:3031/  → 200
   *
   * A running frontend therefore read as dead — Studio reported the port correctly and
   * then handed out a link to nowhere. `localhost` resolves to whichever family bound,
   * which is the only form that works for both, so appUrl() is the single builder.
   */
  assert.deepEqual(
    containing(/http:\/\/(?:localhost|127\.0\.0\.1):\$\{/, clientFiles()),
    ['client/src/lib/stores/world.svelte.ts'],
    'use appUrl(port) from world.svelte.ts rather than composing a dev-server URL',
  );
});

test('every spawn of a long-lived child handles a failed spawn', () => {
  /*
   * A spawn that never happens arrives as an async 'error' event, not a throw. Unhandled,
   * crash.ts treats it as fatal and the daemon exits — so one HTTP request against a
   * deleted worktree took down every terminal. servers.ts was the one site missing the
   * guard that runner.ts, installDeps and hunks.ts all had.
   */
  for (const rel of ['server/servers.ts', 'server/runner.ts']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // `= spawn(` only: the word also appears in prose about spawning.
    const spawns = (text.match(/=\s*spawn\(/g) || []).length;
    const guards = (text.match(/\.once\('error'/g) || []).length;
    assert.ok(guards >= spawns, `${rel}: ${spawns} spawn() call(s) but only ${guards} 'error' handler(s)`);
  }
});
