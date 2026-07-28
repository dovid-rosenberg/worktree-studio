# Handoff — paused 2026-07-28

`main` is clean, green, and running. Everything below is optional forward work.

## State

| | |
|---|---|
| `main` | `4f11b8b`, working tree clean, **542 tests passing**, `npm run typecheck` exits 0 |
| Your daemon | pid on `:7788`, serving the **SvelteKit** UI, 3 sessions / 12 repos / 4 dev servers |
| Pushed? | **No.** `main` is ~110 commits ahead of `origin/main`. Nothing was ever pushed. |
| Rollback | `git reset --hard 6dd6b58` returns you to where this started |

`public/` (the old vanilla UI) is still in the repo and still works: `WTS_UI=legacy npm start`.
Don't delete it until you've used the new UI in anger.

## What shipped

Twelve v2 workstreams, then: 10 known bugs, a hardening sweep (5 critical / 20 important),
the SvelteKit cutover, resource leaks, duplication consolidation, Express 5, and TypeScript
Phases 0–1. Details in `tasks/v2-plan.md`.

Notable, because they're easy to lose track of:

- **Auth is on.** Every `/api` request needs the boot token from `<stateDir>/token`, and
  requests pass an `Origin`/`Host` allowlist. The browser gets the token injected into
  `index.html`. SwiftBar, Alfred and `bin/wt-studio.js` read the token file.
- **`unhandledRejection` is now fatal** (Node's default). If the daemon ever exits
  unexpectedly, that's the first suspect. tmux sessions survive; a restart restores.
- **A missing `client/build` is a fatal boot error**, by design. `npm run build` fixes it;
  `npm install` also builds it.
- **The SSE stream is three named events** — `topology`, `session-state`, `ci`. A client
  must keep both halves verbatim and *derive* state, not patch one object in place.

## Resuming the ESM/TypeScript migration

Branch `chore/esm-typescript`, worktree `.worktrees/esm-ts`, 5 commits, **55 of 71 server
modules converted**. The branch tip does **not** typecheck — that's expected mid-migration.

```
cd .worktrees/esm-ts
npm install && npm rebuild node-pty && node bin/fix-pty.js && node bin/vendor.js && node bin/build-client.js
npm run typecheck        # will be red; that IS the remaining work
```

Verified facts this rests on — don't re-derive them:

- Node 22.21 runs `.ts` **natively, no flag, no build step**, under `"type": "module"`.
  `npm start` stays `node server/server.ts`.
- `erasableSyntaxOnly: true` makes tsc reject anything Node can't strip (`enum`,
  `namespace` → **TS1294**). Keep it on; it's the guardrail.
- **`.ts` cannot work under CommonJS.** Extensionless `require('./util')` won't resolve
  `util.ts` (`require.extensions` is `['.js','.json','.node']`), and a `.ts` using
  `module.exports` runs but tsc won't export it (`TS2459`). That's why this is an ESM
  migration, not a rename.
- Remaining hazards are enumerated: 7 `__dirname` → `import.meta.dirname`; the only
  load-bearing lazy require is `bin/wt-studio.js` booting the daemon in an `else` branch,
  which needs `await import()`.

`strict: true` is on from the start, so this absorbs the old Phase 3. Branch
`chore/typescript-strict` (`e2ea065`, worktree `.worktrees/ts-strict`) holds an earlier
agent's null-safety fixes for 7 modules — reusable reference, deliberately unmerged.

## Queued after that

`tasks/v3-plan.md` — the UI/UX pass and the test-coverage gaps.

Headline of each:
- **Fleet renders two features twice** (`SERVERS RUNNING` duplicates `WORKTREES`), and the
  section exists to surface one non-duplicated row. Deleting it is item 1.1.
- **Client tests are zero.** 41 Svelte components, no vitest/playwright. Every UI bug found
  during the build-out was found by manually driving a browser — none of it repeatable.

## Housekeeping done

- Stopped the migration agent and committed its in-flight work (nothing lost).
- Killed two leftover agent daemons; only yours on `:7788` runs.
- Removed the 7 worktrees whose branches are merged. Two remain, both holding unmerged work.
- Live state backed up at `~/.local/state/worktree-studio.backup-213013`.

## Known open items

See `tasks/v3-plan.md` §3. The two worth remembering: `/group/pr` still loops members
serially, and there were two unexplained single-run test failures during the build-out —
neither reproducible across 8 and 17 subsequent clean runs, both alongside concurrent
daemon teardown. Logged as unexplained, not dismissed.
