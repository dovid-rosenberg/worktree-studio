# Configurable conventions

Four of Worktree Studio's owner's personal workflow conventions were constants in
the source. They are configuration now, and **every default reproduces the old
behavior exactly** — the existing install needs no config change.

## Plan

- [x] 1. `server/layout.js` — pure worktree-layout resolver (nested / sibling /
      external) + `nameFromPath`. Config: `worktrees: { layout, dir, root }`.
- [x] 2. `server/identity.js` — pluggable feature-identity strategy
      (`basename` / `branch` / `manifest`), built on layout. One resolver serves
      BOTH `computeFeatures()` grouping and `featureFromPath()` slot keying so the
      two can never disagree. Config: `featureIdentity: { strategy, branchPattern, branchFlags }`.
- [x] 3. Wire layout into `worktree.js` (dest, gitignore warning) and `git.js`
      (a linked worktree the walk stumbles on is not a repo).
- [x] 4. Wire identity into `features.js`, `servers.js`, `state.js`,
      `orchestrator.js`, `server.js`.
- [x] 5. copyPatterns: additive editor-agnostic defaults + make the hardcoded
      `.idea/runConfigurations` copy configurable (`copyAlways`).
- [x] 6. Empty the accept.blue concurrency defaults; one-time migration so an
      existing install that relied on them keeps working.
- [x] 7. Docs: `docs/config.md` + `docs/api.md` + `MANUAL.md` config table.
- [x] 8. Tests + live server smoke test.

## Review

### New config keys

| Key | Default | What it replaces |
|---|---|---|
| `worktrees.layout` | `nested` | the literal `.worktrees` in 4 places |
| `worktrees.dir` | `.worktrees` | — |
| `worktrees.root` | `''` | — |
| `featureIdentity.strategy` | `basename` | `w.wtname` as the only grouping key |
| `featureIdentity.branchPattern` | `''` | — |
| `featureIdentity.branchFlags` | `''` | — |
| `copyAlways.default` | `['.idea/runConfigurations/*.xml']` | the hardcoded, unconditional JetBrains copy in `populate()` |
| `copyAlways.<repo>` | — | — |
| `concurrency.repos` | `{}` (was one company's port map) | — |

`copyPatterns.default` additionally gains `.env*` and `.vscode/*.json`.

### Every hardcoded site found

Beyond the four named in the brief:

- `server/servers.js` `_portsFor()` — derived the slot key from a path for `stop()`.
- `server/servers.js` `reconcileSlots()` — same, over lsof's realpaths.
- `server/server.js` — five slot-key sites (`/servers/start|stop|restart`,
  `/sessions/:id/servers/start|stop`, `DELETE /sessions/:id`).
- `server/orchestrator.js` — seven slot-key sites across the `/group/*` verbs.
- `server/sessions.js` — three `worktree.create()` calls, plus the manager needing
  a layout of its own.
- `server/git.js` `walkTree()` — assumed worktrees hide behind a dot-dir the walk
  skips. True only for `nested`; `sibling`/`external` worktrees would have been
  listed as repos of their own.
- `server/worktree.js` `create()` — `git worktree add` does not create the parent
  directory, which only matters once the parent can be outside the repo.
- `docs/api.md` — the vocabulary promised `<repo>/.worktrees/<name>` and "the
  shared worktree name" as facts clients could rely on.
- `MANUAL.md` — the glossary and the configuration table.

Checked and correctly convention-free: `swiftbar/*.sh` and `alfred/src/filter.sh`
(they read `.features[]` / `.repos[].worktrees[]` off the API), `bin/wt-studio.js`,
`server/transcripts.js` (its `.worktrees` mention is a comment about Claude Code's
own path-slug algorithm, and the code is path-generic).

### Did `manifest` collapse into manual groups?

Yes, as a strategy rather than a new key: `manifest` reads `config.groups`. What
it adds is reach — manual groups only ever shaped the Fleet grouping while slot
keying kept using the directory name, so a manual group whose members are named
differently per repo got a slot each and its repos collided on ports. Under
`manifest` the group name is the identity everywhere.

### Keeping `featureFromPath()` and `computeFeatures()` in agreement

They are one function now. `identity.of(worktree)` is the implementation;
`identity.ofPath(path)` looks the path up in an index rebuilt on every repo scan
(`server/server.js` `rescan()`) and calls `of()` with the worktree it finds. On a
miss it degrades to the layout name — exactly what the old path-only function
returned. `Servers` holds the same resolver instance `state.js` groups with.

The index is only built for the strategies that need it, so `basename` — the
default — costs nothing and cannot be affected by a stale index.

`watch.js` awaits the first scan before the first lsof sweep, so the index is
always populated before `reconcileSlots()` runs.

### Proof of no regression

`test/no-regression.test.js` reimplements the three replaced functions verbatim
and asserts every new path equals them over a realistic corpus, under a checked-in
copy of the owner's actual config shape. 412 tests pass (320 baseline).
