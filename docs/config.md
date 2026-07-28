# Conventions: worktree layout, feature identity, copy patterns, concurrency

Worktree Studio grew up around one person's workflow. Four of that workflow's
conventions used to be constants in the source. They are configuration now, and
**every default reproduces the old behavior exactly** — an existing install needs
no config change at all.

This document is the reference for those four blocks. The full key-by-key table
lives in [MANUAL.md](../MANUAL.md#configuration-reference); this is the "why and
how" for the ones with real choices in them.

Config file: `~/.config/worktree-studio/config.json`
(override with `WT_STUDIO_CONFIG`).

---

## 1. Where worktrees live — `worktrees`

```jsonc
"worktrees": {
  "layout": "nested",     // "nested" | "sibling" | "external"
  "dir": ".worktrees",    // nested only — the container inside the repo
  "root": ""              // external only — the root of the worktree tree
}
```

| `layout` | A worktree named `feat-a` of repo `/code/api` lands at | Needs gitignoring? |
|---|---|---|
| `nested` *(default)* | `/code/api/.worktrees/feat-a` | yes — `dir` must be in the repo's `.gitignore`, or Studio warns |
| `sibling` | `/code/feat-a` | no — it is outside the working tree |
| `external` | `<root>/api/feat-a` | no |

Notes:

- `dir` may be several segments (`".git/wt"`). Leading and trailing slashes are stripped.
- `external` **requires** `root`; without it Studio warns and falls back to `nested`.
  `~` is expanded.
- Studio creates the parent directory as needed — `git worktree add` will not.
- Under `sibling` and `external`, a worktree can end up inside a `baseDirs` root.
  It is not listed as a repo of its own: the scan recognises a linked worktree by
  its `.git` **file** and skips it, so it appears exactly once, under the repo it
  belongs to.

A worktree is always named by its last path segment. Under `nested` the name is
read as the segment *after* `dir`, so a path pointing **inside** a worktree (a
process's cwd, for instance) still resolves to the worktree rather than to a
subdirectory.

---

## 2. What makes two worktrees one feature — `featureIdentity`

A *feature* is a unit of work owning one worktree in each of several repos.
Everything downstream keys off that identity: Fleet grouping, concurrency slots,
multi-repo sessions, the SwiftBar menubar, and `wt-studio add-repo`.

```jsonc
"featureIdentity": {
  "strategy": "basename",  // "basename" | "branch" | "manifest"
  "branchPattern": "",     // branch only — a regex with one capture group
  "branchFlags": ""        // branch only — regex flags; g and y are ignored
}
```

### `basename` (default)

Two worktrees are the same feature when their directory names match
byte-for-byte. This is the historical convention, and it is why the house rule
"same feature across repos → identical worktree name" exists.

```
/code/api/.worktrees/custom-reports   ┐
/code/fe/.worktrees/custom-reports    ├─ feature "custom-reports"
/code/su/.worktrees/custom-reports    ┘
```

### `branch`

Two worktrees are the same feature when a capture group of `branchPattern`,
applied to their branch names, yields the same string. Use this when the
per-repo branch names differ but share a ticket number.

```jsonc
"featureIdentity": {
  "strategy": "branch",
  "branchPattern": "^(?:fix|feat|chore)/(\\d+)-"
}
```

```
api  worktree "payment-fix"  branch fix/123-payment   ┐
fe   worktree "payment-ui"   branch feat/123-ui       ┴─ feature "123"
```

Rules, all of them deliberate:

- **No match, or no branch at all** (a detached worktree) → falls back to the
  worktree's directory name. Worktrees outside the scheme still group sensibly.
- **Several capture groups** → the leftmost one that actually captured wins.
  Use `(?:…)` for grouping you do not want to claim the identity, e.g.
  `^(?:(?:JIRA-(\d+))|(?:TICKET-(\d+)))`.
- **No capture group at all** → rejected at load with a warning; the pattern
  could only ever match, never extract.
- **An invalid regex** → warning on stderr, strategy falls back to `basename`.
  A bad *value* never stops the server booting. (A bad *syntax* does — see
  "If config.json won't parse" below. The difference is that a value Studio
  can't use has a safe default, and a file it can't read has no contents at
  all.)
- `g` and `y` flags are stripped: they make `exec()` stateful, so the same branch
  would match on one call and miss on the next.

### `manifest`

Explicit mapping. It reads the **existing `groups` key** rather than adding a
second place to write the same thing:

```jsonc
"featureIdentity": { "strategy": "manifest" },
"groups": [
  { "name": "Alpha", "members": ["api/wt-a", "fe/feature/alpha"] }
]
```

Each member is `"<repo>/<worktree-name>"` or `"<repo>/<branch>"`. A worktree not
listed in any group keeps its own directory name.

What `manifest` adds over plain manual groups is *reach*. Manual groups have
always shaped the Fleet grouping, but the concurrency slot key kept using the
directory name — so a manual group whose members are named differently in each
repo got **a slot each**, and its repos collided on ports. Under `manifest` the
group name is the identity everywhere: grouping and slotting alike.

### Why grouping and slot keying cannot disagree

Two callers need this answer. `computeFeatures()` has whole worktree objects.
The concurrency slot key often has nothing but a path. They used to derive it
separately, so a feature could be grouped one way and slotted another — two
worktrees of one feature getting two slots, and their dev servers colliding.

`server/identity.ts` is now the only answer. `of(worktree)` is the
implementation; `ofPath(path)` looks the path up in an index rebuilt from every
repo scan and calls `of()` with the worktree it finds. The path form *is* the
object form. On an index miss it degrades to the layout name — exactly what the
old path-only function returned.

---

## 3. What gets copied into a new worktree — `copyPatterns`, `copyAlways`

`git worktree add` gives you a clean checkout and nothing else. Two lists fill in
the rest, and the difference between them matters.

```jsonc
"copyPatterns": {
  "default": [".env", ".env.local", ".env.*.local", ".env*",
              "config/*-config.js", "src/config.js", "src/config/config.js",
              ".vscode/*.json"],
  "merchant-v3": ["…"]                       // optional per-repo override
},
"copyAlways": {
  "default": [".idea/runConfigurations/*.xml"]
}
```

| | copied when | for |
|---|---|---|
| `copyPatterns` | **only if git ignores the file** | local, gitignored config — `.env`, per-worktree config files |
| `copyAlways` | unconditionally | editor scratch a checkout will not bring along |

The gitignore gate on `copyPatterns` is not an optimisation: a *tracked* file
already arrives with the checkout, and copying the main checkout's copy over it
would silently import whatever uncommitted edits were sitting there.

`copyAlways` is the JetBrains run-config copy that used to be hardcoded and
unconditional. Its default is exactly what that code did. Set it to `[]` to turn
it off, or point it at your own editor's files.

Patterns support `*` within one path segment. `.env*` matches `.env`,
`.env.local`, `.env.production.local`; `.vscode/*.json` matches every JSON file
one level down.

Both `.default` lists are **unioned** with the shipped defaults on every load, so
a config listing an older subset still picks up newly shipped patterns and keeps
its own additions. Per-repo overrides replace the default list outright and are
never touched by the merge.

> `~/bin/wt`, the standalone shell script, keeps its own `DEFAULT_PATTERNS` and
> reads `$(git rev-parse --git-common-dir)/wtcopy`. It is a separate tool and is
> not affected by anything here.

---

## 4. Running several features at once — `concurrency`

Each feature gets a **slot** (0, 1, 2…). Slot *n* offsets every dev-server port
by `n * offsetStep` and sets each `slotEnv` key to *n*. Slot 0 is the repo's
configured ports untouched, so a single feature behaves exactly as it did before
concurrency existed.

```jsonc
"concurrency": {
  "enabled": true,
  "offsetStep": 100,
  "maxSlots": 3,
  "repos": {}          // ships EMPTY — see the worked example below
}
```

`repos` is empty by design: the port map is one organisation's, not a default.

Per-repo wiring:

| Key | Meaning |
|---|---|
| `portEnv` | `{ ENV_VAR: basePort }` — the var is set to `basePort + slot*offsetStep`, and that port is what Studio pre-checks and polls |
| `slotEnv` | `[ENV_VAR]` — set to the slot *index*, not a port (e.g. a Redis DB number) |
| `configPatch` | `{ file, siblingRepo }` — a gitignored config file in this repo's worktree that hardcodes `siblingRepo`'s ports; on launch, every one of that sibling's port families in it is shifted to this feature's slot |

Two footguns Studio warns about (it warns, it never throws):

- `maxSlots > 16` — `slotEnv` values are used as Redis DB indices, and Redis ships 16.
- Two base ports in one repo whose difference is a multiple of `offsetStep` within
  slot range — they collide at some slot. Raise `offsetStep` or lower `maxSlots`.

### A fully worked example

This is the accept.blue setup that used to ship as the built-in default: one
Node backend serving five port families, and three frontends whose gitignored
config files hardcode the backend's ports.

```jsonc
"concurrency": {
  "enabled": true,
  "offsetStep": 100,
  "maxSlots": 3,
  "repos": {
    "accept-blue": {
      "portEnv": {
        "api__port_su": 1231,
        "api__port_iso": 1232,
        "api__port": 1233,
        "api__port_merchant": 1239,
        "api__port_internal": 1999
      },
      "slotEnv": ["redis__db"]
    },
    "merchant-v3": {
      "portEnv": { "WTS_FE_PORT": 3030 },
      "configPatch": { "file": "src/config.js", "siblingRepo": "accept-blue" }
    },
    "ab-iso-fe": {
      "portEnv": { "WTS_FE_PORT": 9000 },
      "configPatch": { "file": "src/config/config.js", "siblingRepo": "accept-blue" }
    },
    "ab-su": {
      "portEnv": { "WTS_FE_PORT": 8000 },
      "configPatch": { "file": "src/config/config.js", "siblingRepo": "accept-blue" }
    }
  }
}
```

At slot 1 the backend comes up on 1331/1332/1333/1339/2099 with `redis__db=1`,
merchant-v3's Vite server on 3130, and merchant-v3's `src/config.js` is rewritten
so every `localhost:12xx` reference points at the slot-1 backend. `ab-su`
references three of the backend's families at once, which is why `configPatch`
shifts *all* of a sibling's families together rather than one named port.

The rewrite is idempotent and port-family-safe: `localhost:1239` never matches
inside `localhost:12390`, and re-running it on an already-shifted file is a no-op.

The backend's **database** is deliberately still shared across slots, and the job
scheduler must only ever run in one stack.

### Upgrading from a config with no `concurrency` key

This block used to live in the built-in defaults, and defaults are merged into
your config at load time — so an install whose `config.json` never wrote a
`concurrency` key was *running on it* without saying so. Emptying the defaults
would have turned concurrency off under such an install.

So: a config that has no `concurrency` key at all gets the old block written into
it, once, on the next load, and owns it from then on. Nothing else in the file is
touched. A config created from today's defaults always has the key (with an empty
`repos`) and never triggers this.

If you do not want that block, delete `concurrency.repos` from your config after
the first load, or set it to `{}`.

---

## `session.feature` under the non-default identity strategies

A session records the feature identity of its worktree as `session.feature`
(`sessions.json`), resolved through the same `featureIdentity` strategy the
Fleet rail groups by. The "Open PR for this feature" button (`POST /group/pr`)
and the transcript search grouping key both read it, so both find the right
feature under every strategy.

This used to store the worktree's *directory name* instead. The two coincide
under `basename`, so the mismatch only surfaced under `branch`/`manifest`, where
the PR button looked up a feature that did not exist.

Naming is a separate question and did not move with it. The worktree name
`wt-studio add-repo` gives a sibling worktree, and the branch name used when a
session has none (`feature/<name>`), still come from the session's own worktree
name — under `branch`, a feature identity like `4821` is a ticket number, not a
directory name.

Sessions written before the split keep working: the naming fallback ends at
`session.feature`, which is exactly what those rows hold.

---

## If config.json won't parse

Studio refuses to start and prints the parse error, the file name and the line.
It does **not** overwrite the file — what is on disk stays byte-for-byte what
you wrote. Fix the syntax error and start it again.

This matters because `config.json` is a file you are invited to edit (SwiftBar
has an "Edit config…" item), and seeding defaults over an unreadable one would
silently discard `baseDirs`, `start`, `editors`, `groups` and the whole
`concurrency.repos` port map. An absent or empty file is a different thing
entirely and is still seeded with defaults on first run.

The state files (`sessions.json`, `servers.json`) are not hand-edited, so a
corrupt one does not block boot: it is renamed to `<name>.corrupt-<timestamp>`,
reported on stderr, and Studio continues with empty state. The copy is kept
because `sessions.json` holds the `claudeSessionId` values that tie a session to
a live claude conversation.
