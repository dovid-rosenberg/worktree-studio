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

Branch `chore/esm-typescript`, worktree `.worktrees/esm-ts`, 6 commits, **63 of 71 server
modules converted** — only 8 `.js` files left. The branch tip does **not** typecheck; that's
expected mid-migration.

Two real bugs strict mode already caught in `orchestrator`, both preserved in `c17587f`:
`/group/session` dereferenced an unknown-repo lookup unguarded (`TypeError` → 500 leaking an
internal message, while the loop three lines below already guarded the identical lookup), and
`/group/delete` read the `WorktreeRemoveResult` union unnarrowed.

A third bug, in `servers.startCfg()` (`1383a94`): a `start` entry of the object form with
`ports` but no `cmd` produced `{ cmd: undefined, ports: [...] }`, which is **truthy** — so
`decorate()` advertised `canStart: true` for a repo that cannot start, and `start()` reached
`spawn('bash', ['-lc', undefined])`, throwing a `TypeError` out of an async route handler
(500) instead of returning `{ ok: false, error }`. `POST /settings` drops cmd-less rows, but
a hand-edited `config.json` can carry one.

### `types.ts` gaps flagged but deliberately not fixed

- `Config.editors` is `Record<string, { open: string }>`, but **`openGroup` is a real shipped
  key** — read in `orchestrator`, written by `server.js`, documented in `docs/api.md`,
  exercised in `test/no-regression.test.js`. Wants `{ open: string; openGroup?: string }`.
- `StartConfig` **does not model the string form**, though `servers.ts` supports
  `start[repo] = "npm run dev"` (worktree-dash compat; `config.js` copies `dash.start`
  verbatim). Wants `string | { cmd?: string; ports?: number[] }`. Its
  `[key: string]: unknown` index signature is also worth dropping — it survives `PartialDeep`
  and makes every consumer's access `unknown`-adjacent.
- `Config._stateDir` is optional but is stamped on every loaded config; making it required
  removes the single `!` assertion in `servers.ts`.

### Note: late work may still arrive

The migration agent had spawned child agents. Several finished **after** it was stopped and
their work was committed here in `c17587f` and `1383a94`. If more land, they'll appear as
uncommitted changes in this worktree — check with `git -C .worktrees/esm-ts status` before
resuming, and commit anything found rather than assuming the tree is where you left it.

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
