# Handoff — updated 2026-07-28 (migration merged)

`main` is clean, green, and running. Everything below is optional forward work.

## State

| | |
|---|---|
| `main` | `717b19d`, working tree clean, **542 tests passing**, `npm run typecheck` exits 0 |
| Your daemon | pid on `:7788`, serving the **SvelteKit** UI, 3 sessions / 12 repos / 4 dev servers |
| Pushed? | **No.** `main` is ~130 commits ahead of `origin/main`. Nothing was ever pushed. |
| Rollback | `git reset --hard 3030597` undoes the migration merge; `6dd6b58` returns you to where all this started |

`public/` (the old vanilla UI) is still in the repo and still works: `WTS_UI=legacy npm start`.
Don't delete it until you've used the new UI in anger.

## What shipped

Twelve v2 workstreams, then: 10 known bugs, a hardening sweep (5 critical / 20 important),
the SvelteKit cutover, resource leaks, duplication consolidation, Express 5, and the full
ESM/TypeScript migration. Details in `tasks/v2-plan.md`.

Notable, because they're easy to lose track of:

- **Auth is on.** Every `/api` request needs the boot token from `<stateDir>/token`, and
  requests pass an `Origin`/`Host` allowlist. The browser gets the token injected into
  `index.html`. SwiftBar, Alfred and `bin/wt-studio.ts` read the token file.
- **`unhandledRejection` is now fatal** (Node's default). If the daemon ever exits
  unexpectedly, that's the first suspect. tmux sessions survive; a restart restores.
- **A missing `client/build` is a fatal boot error**, by design. `npm run build` fixes it;
  `npm install` also builds it.
- **The SSE stream is three named events** — `topology`, `session-state`, `ci`. A client
  must keep both halves verbatim and *derive* state, not patch one object in place.

## The ESM/TypeScript migration — DONE

Merged into `main` as `717b19d`. **71 of 71 server modules are `.ts`**, there is no
`require(` left under `server/` or `bin/`, and `npm start` is a bare
`node server/server.ts` with no build step.

- `npx tsc --noEmit` → **0 errors**
- `npm test` → **542 pass / 0 fail** (all 542 *ran*; the branch sat at 299/542 only
  because whole test files failed to **load**)

Verified beyond the suite: booted `node server/server.ts` against a throwaway
config/state dir — tmux detected, SvelteKit UI served, `/api` 401s without the boot token
and 200s with it, and all three SSE event types (`topology`, `session-state`, `ci`) arrive
on `/api/v1/events`.

### What was left, and what it turned out to be

Exactly as scoped: convert five modules (`server`, `state`, `transcript-routes`,
`multiplexer/index`, `multiplexer/tmux`) and rewrite the stale `./config.js` /
`./features.js` / `../server/sessions.js` specifiers. Those specifiers were the whole
reason 243 tests never ran — nothing was wrong with the code they pointed at.

### Bugs the type checker surfaced

Five from strict mode. Three were already caught (`c17587f`, `1383a94`):

1. `orchestrator` `/group/session` dereferenced an unknown-repo lookup unguarded.
2. `orchestrator` `/group/delete` read the `WorktreeRemoveResult` union unnarrowed.
3. `servers.startCfg()` returned `{ cmd: undefined, ports }` — **truthy** — so
   `decorate()` advertised `canStart: true` and `start()` reached
   `spawn('bash', ['-lc', undefined])`.

Two more in the final pass:

4. **`forge` `/group/pr` pushed a null branch into a git argv.** A *detached* worktree is
   a real member of a resolved feature and carries `branch: null`; execFile rejects a
   non-string argv entry with a TypeError, and because `/group/pr` loops members serially,
   that 500 took every later member of the feature with it.
5. **`server` `/commits` and `/commit-detail` passed an undefined `defaultBranch`** into
   `review.commits()`, reaching `git merge-base HEAD undefined`, for any repo absent from
   the scan cache. Now goes through `defaultBranchOf()` — the `|| 'main'` fallback
   `routes-review.ts` already used.

Two contract holes closed on the way: express query params (`?repo=`, `?sha=`,
`?worktreePath=`, the `/ws/term` upgrade URL) were read without collapsing
`string | array | object`; and `manager.mux` was `Partial<SessionMux>` with a `!` at all 16
call sites while `SessionMux` declared **neither** `ensureSplit` nor `attachSpawn` — the two
members `server.ts`'s `/split/*` routes and `term.ts` actually reach through it, so a driver
missing them typechecked.

### `types.ts` gaps — both now fixed

- `Config.editors` was `Record<string, { open: string }>` while **`openGroup` is a shipped
  key** (read by `orchestrator`, written by `POST /settings`, documented in `docs/api.md`).
  Now a named `EditorConfig`.
- `StartConfig` did not model the bare-string form (`start[repo] = "npm run dev"`,
  worktree-dash compat, which `servers.startCfg()` has always handled), and its
  `[key: string]: unknown` index signature survived `PartialDeep`, making every consumer's
  access `unknown`-adjacent. Now `string | { cmd?; ports? }` with no index signature.
- ~~`Config._stateDir` optional → required removes the `!` in `servers.ts`.~~ **Wrong — I
  was mistaken.** `PartialDeep<T>` is `{ [K in keyof T]?: … }`, so it re-optionalizes *every*
  key regardless of what `Config` declares, and every consumer takes `PartialDeep<Config>`.
  The seam is `PartialDeep`, not the `?`.

### Still open: the test files are `.js`

The 32 files under `test/` are ESM and they exercise the typed modules, but they sit
**outside `tsconfig.json`'s `include`**, so they are not themselves type-checked — even
though that config already anticipates `test/**/*.ts`. ~8,400 lines. Converting them puts
the test doubles under `strict`, which is where a contract drift would actually be caught.
Deliberately not bundled into a green-suite migration; it is its own piece of work.

### Facts the setup rests on — don't re-derive them

- Node 22.21 runs `.ts` **natively, no flag, no build step**, under `"type": "module"`.
  `npm start` is `node server/server.ts`, and `bin` points at `bin/wt-studio.ts`.
- `erasableSyntaxOnly: true` makes tsc reject anything Node can't strip (`enum`,
  `namespace` → **TS1294**). Keep it on; it's the guardrail.
- **`.ts` cannot work under CommonJS.** Extensionless `require('./util')` won't resolve
  `util.ts` (`require.extensions` is `['.js','.json','.node']`), and a `.ts` using
  `module.exports` runs but tsc won't export it (`TS2459`). That is why this had to be an
  ESM migration rather than a rename.
- `bin/wt-studio.ts` boots the daemon with `await import('../server/server.ts')` in an
  `else` branch — a **dynamic** import on purpose. A static one at the top would run
  `main()` for `wt-studio add-repo` too.

Branch `chore/typescript-strict` (`e2ea065`, worktree `.worktrees/ts-strict`) holds an
earlier agent's null-safety fixes for 7 modules. `strict: true` was on from the start of
the migration, so those fixes are now redundant — the worktree can be removed.

## Queued next

`tasks/v3-plan.md` — the UI/UX pass and the test-coverage gaps.

Headline of each:
- **Fleet renders two features twice** (`SERVERS RUNNING` duplicates `WORKTREES`), and the
  section exists to surface one non-duplicated row. Deleting it is item 1.1.
- **Client tests are zero.** 41 Svelte components, no vitest/playwright. Every UI bug found
  during the build-out was found by manually driving a browser — none of it repeatable.

## Housekeeping done

- Stopped the migration agent and committed its in-flight work (nothing lost).
- Killed two leftover agent daemons; only yours on `:7788` runs.
- Removed the 7 worktrees whose branches are merged. `.worktrees/esm-ts` is now merged too
  and can go; `.worktrees/ts-strict` holds the superseded null-safety branch.
- Live state backed up at `~/.local/state/worktree-studio.backup-213013`.

## Known open items

See `tasks/v3-plan.md` §3. The two worth remembering: `/group/pr` still loops members
serially (a detached member no longer takes its siblings down with it, but a wedged one
still delays them), and there were two unexplained single-run test failures during the build-out —
neither reproducible across 8 and 17 subsequent clean runs, both alongside concurrent
daemon teardown. Logged as unexplained, not dismissed.
