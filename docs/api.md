# Worktree Studio HTTP API

Derived from `server/` — this is the contract, not a tutorial. For what the app
*does*, read `MANUAL.md`.

## Base URL, versioning, transport

The server binds `config.web.host` / `config.web.port` (default
`http://127.0.0.1:7788`). It is a local dev tool, but "loopback-only" is not a
security boundary — see *Authentication* below. Every request is checked; there
are still no CORS headers and no rate limiting.

Every API route is registered once and served under two prefixes:

| Prefix     | Status                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| `/api/v1`  | The versioned contract. New clients should build against this.          |
| `/api`     | Unversioned alias, byte-identical. Kept for SwiftBar, Alfred and the web UI. |

`/api/v1/state` and `/api/state` are the same handler; the tables below list
routes without the prefix, so `/state` means `/api/v1/state` *or* `/api/state`.

Two endpoints are deliberately **not** under either prefix, because their URLs
are baked into things outside the server:

- `POST /hook/:event` — the Claude Code hook receiver (the URL is written into
  every session's generated `--settings` file).
- `ws://…/ws/term` — the terminal WebSocket.

Requests: `application/json` bodies up to 8 MB (`text/*` is also accepted and
arrives as a string — only the hook receiver uses that). Responses are JSON
unless stated otherwise.

## Authentication

Three checks, in this order, on **every** request including the static assets and
the WebSocket upgrade. They stop different attacks; a client has to satisfy all
of them.

| Check    | Applies to                    | Failure                             |
| -------- | ----------------------------- | ----------------------------------- |
| `Host`   | everything                    | `403 { error: 'forbidden host' }`   |
| `Origin` | everything, when present      | `403 { error: 'forbidden origin' }` |
| token    | `/api/**`, `/hook/*`, `/ws/term` | `401 { error: 'missing or invalid token' }` |

**Host** must name a loopback host (`127.0.0.1`, `localhost`, `::1`) or the
configured `web.host`, on the configured port. This is the DNS-rebinding defense:
a page that re-resolves its own domain to 127.0.0.1 becomes same-origin and CORS
stops applying, but the browser still sends the attacker's domain in `Host`.

**Origin**, *when the request carries one*, must be `http(s)://<loopback>:<port>`
for this server's port. Absent is allowed — every non-browser client (curl,
SwiftBar, Alfred, the CLI, the hook script) sends none, and the token covers
those. `Origin: null` is refused. Note WebSockets are exempt from CORS entirely,
so this check on the upgrade is what stops any open browser tab from attaching a
terminal.

**Token** — a 64-hex-char secret generated on first run and stored at
`<stateDir>/token`, mode `0600` (`~/.local/state/worktree-studio/token` by
default; `WT_STUDIO_STATE` moves it). It is stable across restarts, because live
sessions have it baked into hook URLs. Present it as:

- `x-wts-token: <token>` — preferred; what the web UI, the CLI, SwiftBar and
  Alfred send.
- `Authorization: Bearer <token>`.
- `?token=<token>` — for the two transports that cannot set a header:
  `EventSource` (`/api/events`) and the terminal WebSocket. The generated hook
  URLs use this form too.

The web UI gets the token by having it substituted into `index.html` at serve
time (`window.WTS_TOKEN`). That is safe only because of the `Host`/`Origin`
gate: a cross-origin page cannot read the document, and a rebinding one is
refused before there is a document to read.

### Errors

| Status | Meaning                                                                     |
| ------ | --------------------------------------------------------------------------- |
| 400    | Bad or unresolvable input (`{ error }`), e.g. unknown repo, missing field.   |
| 401    | Missing or invalid token (`{ error }`) — see *Authentication*.                |
| 403    | Disallowed `Host` or `Origin` (`{ error }`) — see *Authentication*.           |
| 404    | Named session / feature does not exist (`{ error }`).                        |
| 409    | No free concurrency slot (`{ ok: false, error }`) — see *Concurrency slots*. |
| 500    | Unhandled exception in a handler (`{ error: <message> }`), also logged.      |

Many routes answer `200` with `{ ok: false, error }` instead of a 4xx — a failed
*operation* is not a malformed *request*. Two routes use `200` with
`needsConfirm: true` to ask a question rather than fail: `POST
/sessions/:id/promote` (uncommitted work in the main checkout) and `POST
/group/start` (another worktree of the same repo is running).

### Vocabulary

- **repo** — a git repository found by scanning `config.baseDirs`, identified by
  its directory basename.
- **worktree** — a git worktree of a repo. The repo's own checkout is the *main*
  worktree (`isMain: true`); the rest live wherever `config.worktrees.layout`
  says, `<repo>/.worktrees/<name>` by default. Clients must treat `path` as
  opaque and never reconstruct it from the repo and name.
- **feature** — one *feature identity*, across every repo that has a worktree
  with it. Under the default `basename` strategy the identity is the worktree's
  directory name, so `.worktrees/login-fix` in three repos is one feature,
  `login-fix`. `config.featureIdentity.strategy` can key it on a capture group of
  the branch name (`branch`) or on `config.groups` (`manifest`) instead — see
  [config.md](config.md#2-what-makes-two-worktrees-one-feature--featureidentity).
  Features are computed, not stored. A *manual group* from `config.groups` names
  its members explicitly regardless of strategy.
- **session** — a Claude Code process running in a multiplexer (tmux) session,
  owning one or more worktrees.
- **concurrency slot** — a small integer (0, 1, 2…) assigned to a feature while
  its dev servers run. Slot *n* offsets the configured ports by
  `n * concurrency.offsetStep`, which is what lets 2–3 features run at once.

---

## Live state

### `GET /state`

The whole world in one document. Returns the **state payload** (below).

### `GET /events`

`text/event-stream`, carrying the state payload split into two **named event
types** — the payload's two halves have very different change rates, and a
client that re-renders the world on every Claude tool call pays for the
difference:

| Event           | `data:` shape                            | Sent when                                                                                             |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `topology`      | every top-level field except `sessions`/`servers` | The repo→worktree shape or the client's chrome changed: a git rescan (~15 s), a worktree/session mutation, dev-server discovery finding something new, a config save. |
| `session-state` | `{ sessions, servers }`                  | Every state change of any session — i.e. every Claude Code hook, so every tool call. Also rides along with every `topology` frame. |

Both events are **full replacements of their half**, never per-item deltas. A
client applies a frame with `state = { ...state, ...frame }`; that is
idempotent, order-independent, and communicates removals for free (a closed
session is simply absent from `sessions`).

On connect the server writes one `topology` and one `session-state` frame
before the client joins the fan-out, so the pair is always a **complete
snapshot** and a client can never receive an event that predates its snapshot.
A browser's `EventSource` reconnects on its own; a reconnect is just a new
subscriber, so it re-snapshots and converges rather than drifting.

Frames are coalesced with an 80 ms debounce. `:hb` comments every 25 s keep the
connection alive.

> Because a session's `{id, state, activity, muxName}` is embedded in
> `repos[].worktrees[].session` and in `features`/`groups`, those copies are
> only as fresh as the last `topology` frame. A client that renders them should
> re-project the live `sessions` onto them after each frame, keyed by session id
> (`public/app.js`'s `restitchSessions()`).

---

## The state payload

The single document returned by `GET /state`. Built in `server/state.js` from
two halves — a *topology* half (`mux` …`groups`) and a *session-state* half
(`sessions`, `servers`) — which `GET /events` streams separately, at their own
rates, as the two named events above.

### Top level

| Field          | Type      | Meaning                                                                                     |
| -------------- | --------- | ------------------------------------------------------------------------------------------- |
| `mux`          | string    | Active multiplexer name (`"tmux"`), or `"none"` if none was found. With `"none"`, anything that starts a session will fail. |
| `config`       | object    | `{ port: number, configFile: string }` — the port the server is listening on and the absolute path of the config file it loaded. |
| `runningTotal` | number    | Count of worktrees across all repos with a discovered dev server. (SwiftBar's menubar count.) |
| `baseDirs`     | string[]  | Absolute, tilde-expanded directories that are scanned for repos.                             |
| `editors`      | string[]  | Configured editor **names** only (`["WebStorm","Zed"]`). Pass one as `editor` to `/open` and `/group/open`. |
| `defaultEditor`| string    | The editor used when a request omits `editor`.                                               |
| `webRepos`     | string[]  | Repos that serve a browsable frontend — the UI offers "Open app ↗" for these.                |
| `runConfigs`   | object    | `{ "<repo>": [{ name, cmd, kind, source }] }` — imported editor run/test configs. `{}` when none. |
| `sources`      | object[]  | Enabled intake adapters: `{ id, label, needsRepo }`. `id` is what `POST /sessions` takes as `source`. |
| `repos`        | object[]  | Every scanned repo, each with its worktrees. See *Repo*.                                     |
| `features`     | object[]  | Every feature, including single-worktree ones. See *Feature*.                                |
| `groups`       | object[]  | The subset that are real multi-worktree groups: manual groups plus auto groups with ≥ 2 members. Same object shape as `features`. |
| `sessions`     | object[]  | Every session, newest first. See *Session*.                                                  |
| `servers`      | object    | `{ "<sessionId>": { repos: [...] } }` — per-session dev-server view. See *Session servers*.  |

`features` and `groups` are two views of the same computation, not disjoint
sets: a manual group appears in both. Use `features` for a complete list, and
`groups` when you only care about work that spans repos.

### Repo

| Field           | Type     | Meaning                                                        |
| --------------- | -------- | -------------------------------------------------------------- |
| `name`          | string   | Directory basename — the repo's identity everywhere in the API. |
| `repo`          | string   | Same value as `name` (kept for clients that key on `repo`).     |
| `path`          | string   | Absolute path of the main checkout.                             |
| `defaultBranch` | string   | `origin/HEAD`'s branch if resolvable, else the current branch, else `main`. |
| `worktrees`     | object[] | Every worktree of this repo, main checkout first.               |

### Worktree

| Field        | Type            | Meaning                                                                 |
| ------------ | --------------- | ----------------------------------------------------------------------- |
| `repo`       | string          | Owning repo name.                                                        |
| `wtname`     | string          | Directory basename. For the main checkout this equals `repo`. Under a non-`basename` feature identity this is **not** the feature name — read that off the *Feature* the worktree is a member of. |
| `branch`     | string \| null  | Checked-out branch, `null` when detached.                                |
| `path`       | string          | Absolute worktree path. **The identifier** for every server/worktree route. |
| `isMain`     | boolean         | True for the repo's own checkout. Main checkouts are never features and are never session-decorated. |
| `detached`   | boolean         | HEAD is detached.                                                        |
| `merged`     | boolean         | This branch's head is an ancestor of the default branch *and* differs from it — i.e. merged, not merely freshly branched. Always `false` for the main checkout and for detached heads. |
| `baseBranch` | string          | The repo's `defaultBranch`, repeated for convenience.                    |
| `baseDir`    | string          | Which of `baseDirs` this repo was found under (`""` if none matched).    |
| `running`    | boolean         | A listening process's working directory resolves to this worktree. Discovery is by `lsof`, so it sees *any* server here, not only configured ones. |
| `pid`        | number \| null  | That process's pid.                                                      |
| `ports`      | number[]        | Its listening ports, ascending. Ephemeral ports (≥ 49152) and the Studio port itself are excluded. |
| `canStart`   | boolean         | The repo has a `start` command configured, so `/servers/start` can launch it. |
| `session`    | object \| null  | `{ id, state, activity, muxName }` of the session driving this worktree — a deliberately trimmed view of *Session*. `null` for main checkouts and undriven worktrees. |

### Feature

| Field     | Type            | Meaning                                                                       |
| --------- | --------------- | ----------------------------------------------------------------------------- |
| `name`    | string          | The feature identity its members share (the shared worktree name under the default `basename` strategy), or the manual group's name. **The identifier** for every `/group/*` route, and the key a concurrency slot is allocated against. |
| `auto`    | boolean         | `false` for a manual group from `config.groups`, `true` for a discovered one.  |
| `members` | object[]        | Full *Worktree* objects. A manual group member that resolves to nothing is the stub `{ missing: true, ref: "<repo>/<branch-or-name>" }` instead — check `missing` before reading any other field. |
| `session` | object \| null  | The one session driving this feature (the first member that has one), same trimmed shape as `worktree.session`. |
| `slot`    | number          | The feature's concurrency slot, **present only while one is allocated.** Absent means no slot, which is not the same as slot `0`. |

Features are ordered by running-member count descending, then by name.

### Session

Sessions are persisted verbatim (`sessions.json`) and returned as-is by `GET
/state` and by the session routes.

| Field             | Type            | Meaning                                                                 |
| ----------------- | --------------- | ----------------------------------------------------------------------- |
| `id`              | string          | `s_…`. The identifier for every `/sessions/:id/*` route.                 |
| `title`           | string          | Display title (from the seed; editable via `/rename`).                   |
| `source`          | string          | Intake adapter id: `freetext` \| `github` \| `gitlab` \| `asana`.        |
| `sourceId`        | string \| null  | Issue/task id in that source.                                            |
| `sourceUrl`       | string \| null  | Link back to the issue/task.                                             |
| `repoName`        | string          | Primary repo.                                                            |
| `repoPath`        | string          | Primary repo's main checkout.                                            |
| `home`            | string          | Directory Claude's transcript lives in — where `--resume` is run from. Starts as `repoPath`, moves to the worktree once promote's `/cd` lands. |
| `worktree`        | string \| null  | Primary worktree's name; `null` until promoted/adopted.                  |
| `worktreePath`    | string \| null  | Primary worktree's absolute path; `null` until promoted/adopted.         |
| `branch`          | string \| null  | Primary worktree's branch.                                               |
| `feature`         | string          | The feature identity tying this session's worktrees together across repos. |
| `repos`           | object[]        | Every repo this session spans: `{ repo, repoPath, worktree, worktreePath, branch, primary }`. Exactly one is `primary: true` (where Claude launched); the rest are reachable via `--add-dir`. `worktree`/`worktreePath`/`branch` are `null` before promote. |
| `pendingRepos`    | object[]        | `{ repo, repoPath }` chosen up front, added at promote time. Emptied afterwards. |
| `suggestedBranch` | string \| null  | Branch name derived from the seed (`fix/…` for bug-ish wording, else `feature/…`, prefixed with a numeric source id when there is one). |
| `suggestedName`   | string \| null  | Suggested worktree name.                                                 |
| `muxName`         | string          | tmux session name. The split pane lives in `<muxName>-split`.            |
| `claudeSessionId` | string \| null  | Claude's own session id, learned from the `SessionStart` hook; enables `--resume`. |
| `state`           | string          | `idle` \| `working` \| `waiting` \| `stopped`. `waiting` means Claude wants the human. |
| `activity`        | string          | Short human-readable status (`"running Bash"`, `"turn done"`, `"deactivated"`). |
| `tabs`            | object[]        | `[{ title }]` per multiplexer window, in order.                          |
| `seed`            | string \| null  | The single-line prompt handed to Claude at launch.                       |
| `active`          | boolean         | The agent process is meant to be running. `false` after deactivate or a `SessionEnd`. |
| `createdAt`       | number          | Epoch ms. Sessions are returned newest-first by this.                    |
| `promotedAt`      | number \| null  | Epoch ms the session gained a worktree.                                  |
| `settingsFile`    | string          | Generated `--settings` file wiring Claude's hooks back to this server.    |
| `lastEventAt`     | number          | Epoch ms of the last hook event. Absent until the first one arrives.      |
| `adopted`         | boolean         | Present and `true` only for sessions started in a pre-existing worktree.  |

### Session servers

`state.servers` maps a session id to the dev-server state of its whole shared
workspace. Sessions owning no worktree are omitted entirely.

```jsonc
"servers": {
  "s_abc": { "repos": [
    { "repo": "api", "worktreePath": "/code/api/.worktrees/login-fix",
      "running": true, "ports": [1233], "canStart": true }
  ]}
}
```

This overlaps with the `running`/`ports` on each worktree; it exists so a client
can render a session's stack without walking `repos[].worktrees[]`.

---

## Settings

### `GET /settings`

```jsonc
{
  "sources": {},            // raw config.sources, tokens included
  "baseDirs": [],
  "notify": {},             // { waiting, sound, idle } — UI notification prefs
  "start": {},              // { "<repo>": { cmd, ports: [] } }
  "editors": {},            // { "<name>": { open, openGroup? } } — full definitions
  "defaultEditor": "",
  "groups": [],             // manual feature groups
  "enabled": [],            // same shape as state.sources
  "tools": { "gh": true, "glab": false },   // CLI presence on PATH
  "githubAuthed": true      // `gh auth status` exited 0
}
```

> `sources` includes configured tokens in plaintext. It is a loopback endpoint on
> a single-user machine, but do not proxy it anywhere.

### `POST /settings`

Every field is optional; only what is present is touched. Responds with
`{ ok: true, … }` echoing the merged config, and persists to `config.json`.

| Field           | Handling                                                                        |
| --------------- | ------------------------------------------------------------------------------- |
| `sources`       | Per-adapter shallow merge (existing keys survive).                               |
| `notify`        | Shallow merge.                                                                   |
| `baseDirs`      | Full replace; tildes expanded, blanks dropped. Triggers a rescan.                |
| `start`         | Full replace of `{ "<repo>": { cmd, ports } }`; rows without a name or `cmd` are dropped, `ports` is coerced from an array or a comma/space-separated string to positive integers. Triggers a rescan. |
| `editors`       | Full replace; rows without a name or `open` are dropped. `openGroup` kept when non-blank. |
| `defaultEditor` | Set when a non-blank string.                                                     |
| `groups`        | Full replace of `[{ name, members }]`; rows without a name or with no members are dropped. Triggers a rescan. Under `featureIdentity.strategy: "manifest"` this list is also what feature identity is read from, so a change here re-keys features **and** their concurrency slots, live. |

The convention blocks — `worktrees`, `featureIdentity`, `copyPatterns`,
`copyAlways`, `concurrency` — are **not** writable through this endpoint. They are
read once at boot (the identity resolver and the slot registry are built from
them), so they are edited in `config.json` and picked up on restart. See
[config.md](config.md).

`open` / `openGroup` are shell commands with `{path}` / `{paths}` placeholders,
substituted with shell-quoted paths and run via `bash -lc`.

---

## Sources (session intake)

### `GET /sources`

The enabled adapters — identical to `state.sources`.

### `GET /sources/:source/items?repo=<name>&q=<query>`

Pickable items from one adapter. `{ ok: true, items: [{ id, title, subtitle }] }`,
or `{ ok: false, error, items: [] }` if the adapter is disabled or threw. Always
`200`. `repo` is required by adapters whose `needsRepo` is true.

---

## Sessions

### `POST /sessions`

Create a session: seed it from a source, then launch Claude in the repo's **main
checkout** (no worktree yet — that's `promote`).

```jsonc
{ "source": "github",          // default "freetext"
  "sourceId": "487",           // issue id, for issue-backed sources
  "text": "…", "name": "…",    // freetext body + optional short name
  "repo": "api",               // required, must be a scanned repo
  "additionalRepos": ["fe"] }  // recorded as pendingRepos, added at promote
```

Returns the full *Session*. `400` for an unknown repo, `500` if seeding or
launching failed.

### `POST /sessions/:id/promote`

Create the worktree and move the live session into it. Body: `{ branch?, name?,
confirm? }` — both default to the session's `suggested*` values.

- `200 { ok: false, needsConfirm: true, dirty: [files] }` — the main checkout has
  uncommitted work that would be stranded, because the worktree is branched clean
  off the default branch. Re-POST with `confirm: true` to proceed.
- `200 { ok: true, session, worktree }` on success. `worktree` is
  `{ ok, path, branch, name, base, created, copied: { runConfigs, files }, warnings }`.
- `400 { ok: false, error }` — already promoted, no such session, git failure.

Name collisions auto-suffix (`login-fix` → `login-fix-2`) and report it in
`warnings`. Any `pendingRepos` are fanned out afterwards.

### `POST /sessions/:id/add-repo`

`{ repo }` → create a same-named worktree in that repo, attach it to the session,
and grant the running agent access via `/add-dir`. Also reachable from inside a
session as `wt-studio add-repo <repo>`.

`{ ok: true, session, worktree }`, or `{ ok: true, already: true, session }` if
the repo is already attached, or `{ ok: true, …, attached: true }` when the
worktree already existed and was adopted instead of created. `400` on failure.

### `POST /sessions/:id/rename`

`{ title }` → `{ ok: true }`, or `{ ok: false, error: 'invalid title' }` for a
blank one.

### `POST /sessions/:id/deactivate` · `POST /sessions/:id/activate`

Kill the multiplexer session but keep the record (`{ ok: true }`), and bring it
back resuming the conversation. Activate answers `{ ok: false, error: 'worktree
missing' }` if the worktree is gone rather than faking a resume.

### `DELETE /sessions/:id?kill=false`

End a session for good: stop the dev servers of every worktree it owns, release
their concurrency slots, kill the multiplexer session (unless `kill=false`), and
delete the record and its generated settings file. Worktrees are **kept** — use
`/group/delete` to remove those. `{ ok: true }`, or `{ ok: false }` if unknown.

### `POST /sessions/:id/popout`

Open a native macOS Terminal window attached to the same multiplexer session.
`{ ok: true, cmd }`, or `404`.

### Tabs

| Route                              | Body               | Returns                                    |
| ---------------------------------- | ------------------ | ------------------------------------------ |
| `POST /sessions/:id/tabs`          | `{ title?, cmd? }` | `{ ok }` — new multiplexer window.          |
| `POST /sessions/:id/select-tab`    | `{ index }`        | `{ ok }`                                    |
| `POST /sessions/:id/close-tab`     | `{ index }`        | `{ ok }`; refuses to close the last tab.    |

The **split pane** is a separate multiplexer session (`<muxName>-split`) in the
same worktree with its own independent tabs, created on demand. tmux is the
source of truth for its window list, so these read through rather than from the
session record:

| Route                                  | Body        | Returns                          |
| -------------------------------------- | ----------- | -------------------------------- |
| `GET  /sessions/:id/split/tabs`         | —           | `{ tabs: [{ id, title, active }] }` |
| `POST /sessions/:id/split/tabs`         | `{ title? }`| `{ ok }`                          |
| `POST /sessions/:id/split/select-tab`   | `{ index }` | `{ ok }`                          |
| `POST /sessions/:id/split/close-tab`    | `{ index }` | `{ ok }`                          |

All four `404` for an unknown session.

### Session dev servers

| Route                                | Effect                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `POST /sessions/:id/servers/start`   | Start every startable repo the session owns. Allocates a slot per member's feature **before** launching any of them; `409 { ok: false, error }` if none is free. Returns `{ ok, results: [{ repo, ok, pid?, log?, error? }] }` where `ok` is true if *any* started. |
| `POST /sessions/:id/servers/stop`    | Stop every repo it owns and release their slots. `{ ok: true }`.            |

Both `404` for an unknown session.

### Review

| Route                             | Returns                                                                    |
| --------------------------------- | -------------------------------------------------------------------------- |
| `GET /sessions/:id/commits`       | `{ repos: [{ repo, worktreePath, branch, base, defaultBranch, commits, uncommitted }] }` |
| `GET /sessions/:id/commit-detail` | `{ files: [{ file, status, added, deleted, diff }] }`                        |
| `POST /sessions/:id/commit`       | `{ ok, sha }` or `{ ok: false, error }`                                      |

`commits` are `base..HEAD` newest first, each
`{ sha, author, when, subject, added, deleted, fileCount }`. `base` is the
merge-base of HEAD with the default branch — whichever of the local and
`origin/` merge-bases is *closest* to HEAD, so a stale local ref does not drag in
mainline commits. `uncommitted` summarises the working tree as
`{ fileCount, added, deleted }`.

`commit-detail` takes `?repo=<name>&sha=<sha>`; `sha` defaults to
`uncommitted`, which returns the working tree's changes instead of a commit.
`status` is git's letter (`M`, `A`, `D`, `R`…), `diff` is a raw unified diff.
`400` for a repo the session doesn't own.

`POST /sessions/:id/commit` takes `{ repo, message, paths?, amend? }`. Without
`paths` it stages everything (`git add -A`). `message` is required (`400`).

### `GET /sessions/:id/ci`

PR/MR + CI checks for every repo the session owns that has a worktree and a
branch.

```jsonc
{ "repos": [
  { "repo": "api", "hasPR": true, "provider": "github",
    "number": 412, "url": "https://…", "state": "OPEN",
    "checks": { "passed": 7, "running": 1, "failed": 0, "total": 8 } },
  { "repo": "fe", "hasPR": false }
]}
```

- Providers are tried in order — GitHub (`gh`) first, GitLab (`glab`) as
  fallback — and the first one with a PR/MR wins. `provider` says which answered.
- `state` is passed through verbatim, so it is the provider's own vocabulary
  (`OPEN`/`MERGED`/`CLOSED` vs `opened`/`merged`/`closed`).
- `checks` normalises both forges into one tally. GitHub counts every rollup
  node (neutral/skipped land in `total` only); GitLab maps its single pipeline
  status onto the same shape, so `total` is at most 1 there.
- Never partially fails: a repo whose lookup errors comes back `{ repo, hasPR:
  false }`.
- Results are cached ~20 s per worktree+branch, so polling is cheap. With
  neither CLI installed the route answers immediately with `hasPR: false` for
  every repo.

`404` for an unknown session.

---

## Worktrees

### `POST /worktrees`

`{ repo, branch, name? }` → create a worktree named `name` at the location
`config.worktrees.layout` dictates (`<repo>/.worktrees/<name>` by default),
branching off the default base if `branch` doesn't exist, then copy in the bits a
plain `git worktree add` drops: `config.copyAlways` patterns unconditionally
(JetBrains run configs by default) and `config.copyPatterns` patterns when git
ignores them (`.env`, local config files). Read the created location off `path`
in the response rather than assuming a layout. Returns
`{ ok, path, branch, name, base, created, copied: { runConfigs, files }, warnings }`,
or `{ ok: false, error, path, name, branch }`. At least one of `branch` / `name`
is required (`400`).

### `DELETE /worktrees`

`{ repo, worktreePath, branch?, deleteBranch? }` → `{ ok: true, branchDeleted }`
or `{ ok: false, error }`. The branch is only deleted when both `branch` and
`deleteBranch` are given, and only if git considers it safe (`git branch -d`).

### `POST /worktrees/adopt`

`{ repo, worktreePath, branch?, wtname? }` → start a session in a worktree that
already exists. Returns the *Session*, the existing one if this worktree already
has a session, or `{ error: 'session is already being opened' }` when an adopt
for the same path is already in flight.

---

## Dev servers

Servers are addressed by `{ repo, worktreePath }`. `running` state is
*discovered* (every listening socket → owning process cwd → git worktree), so a
server started outside Studio still shows up; the configured `start[repo]`
command is only used to launch.

| Route                     | Body                      | Returns                                             |
| ------------------------- | ------------------------- | --------------------------------------------------- |
| `POST /servers/start`     | `{ repo, worktreePath }`  | `{ ok: true, pid, log }` or `{ ok: false, error }`   |
| `POST /servers/stop`      | `{ repo, worktreePath }`  | `{ ok: true, killed }`                               |
| `POST /servers/restart`   | `{ repo, worktreePath }`  | as `start`                                           |
| `GET  /servers/logs`      | query, see below          | `{ offset, text, size }`                             |

`start` refuses with `{ ok: false, error }` when a target port is already bound,
when another launch for the same worktree is in flight, or when the repo has no
`start` config. It allocates the feature's concurrency slot first and answers
`409 { ok: false, error }` if none is free. `restart` reuses the feature's
existing slot.

`stop` also frees any process still holding one of the worktree's known ports.
The feature's slot is released only once no sibling repo of that feature is
still running.

`GET /servers/logs?worktreePath=<path>&offset=<bytes>` tails the launch log.
Without `offset` you get the last ~300 lines plus the current byte size as
`offset`; with one you get only the bytes written since. Pass the returned
`offset` back to follow incrementally. A shrunken file (rotation) re-reads from
the start. Unknown/untracked worktrees answer `{ offset, text: "", size: 0 }`.

---

## Features and groups

Every route takes `{ group: "<feature name>" }` and answers `404 { error: 'no
such feature' }` if the name matches neither a feature nor a group. Members that
don't resolve (`missing`) are skipped throughout.

### `POST /group/start`

Start every member that isn't already running and `canStart`.

A **conflict** is another worktree of the same repo already running — it must be
stopped first, because both would bind the same ports. Concurrency-slotted repos
run on their own offset ports and are therefore never in conflict.

```jsonc
// conflicts found, and stopConflicts was not set
{ "ok": true, "needsConfirm": true, "conflicts": [ <worktree>… ], "willStart": [ <worktree>… ] }
```

Re-POST with `{ group, stopConflicts: true }` to stop them (then a ~1.2 s
settle) and continue. On success:

```jsonc
{ "ok": true, "started": 2, "total": 3, "failures": [ { "repo": "fe", "error": "port 3030 already in use (pid 991)" } ] }
```

`409 { ok: false, error }` if a slot can't be allocated — checked for every
member before any of them launches, so a partial stack is never started for lack
of slots. Note `ok` is `true` even when some members failed; read `failures`.

### `POST /group/stop`

Stop every running member and release the feature's slot. `{ ok: true }`.

### `POST /group/restart`

Restart every member that is running or `canStart`, reusing the feature's
existing slot. `{ ok: true }`, or `409` if a slot can't be allocated.

### `POST /group/open`

`{ group, editor? }` → open every member's path in the editor, using its
`openGroup` command once if defined, otherwise `open` per path. `{ ok: true }`,
or `400 { error: 'no editor configured' }`.

### `POST /group/close`

Stop the feature's servers, deactivate its sessions, release its slot. Worktrees
and session records are kept — this is "put it down for now". `{ ok: true }`.

### `POST /group/delete`

`{ group, deleteBranches? }` → for each member: stop its server, close its
session, remove the worktree, and optionally delete the branch. Then release the
slot and rescan.

```jsonc
{ "ok": false, "results": [ { "repo": "api", "ok": true }, { "repo": "fe", "ok": false, "error": "…" } ] }
```

Top-level `ok` is true only if *every* member succeeded. Destructive.

### `POST /group/session`

Ensure exactly one session drives the whole feature. If any member already has a
session, that one is returned (`{ ok: true, session, existed: true }`).
Otherwise the first member is adopted and the rest are attached to it via
`/add-dir`, giving one agent access to every repo of the feature.
`400 { error: 'feature has no members' }` if there is nothing to drive.

### `POST /group/pr`

For each member: push the branch (`git push -u origin <branch>`), then open a PR
with `gh pr create --fill`, falling back to `glab mr create --fill --yes`.

```jsonc
{ "ok": true, "results": [ { "repo": "api", "url": "https://github.com/…/pull/412" },
                           { "repo": "fe",  "error": "glab: not authenticated" } ] }
```

Top-level `ok` is true if *any* member got a URL. Unlike `/sessions/:id/ci`,
creation shells out whether or not the CLI was detected at startup; the reported
`error` is the last provider's first stderr line, or `"gh/glab unavailable or
failed"`.

---

## Editor

### `POST /open`

`{ path, editor? }` → run the editor's `open` command with `{path}` substituted
(shell-quoted) via `bash -lc`. `{ ok: true }`, or `400 { error: 'no editor
configured' }`. Fire-and-forget: a command that fails still answers `ok`.

---

## Hook receiver (not versioned)

### `POST /hook/:event?wts=<sessionId>&token=<token>`

Where Claude Code's hooks report in. The token is in the query string because a
generated settings file can only carry a URL. `:event` is one of `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`,
`SubagentStop`, `SessionEnd`. The body is Claude's hook payload (JSON, or a
`text/*` string that will be parsed, falling back to `{ raw }`).

Each event maps onto the session's `state` / `activity`: `UserPromptSubmit`,
`PreToolUse` and `PostToolUse` → `working`; `Notification` → `waiting` (the
agent needs the human); `Stop` → `idle`; `SessionEnd` → `stopped` and
`active: false`. `SessionStart` also records `payload.session_id` as
`claudeSessionId`, which is what later enables `--resume`.

Always `{ ok: true }`, including for an unknown `wts` — a hook must never block
the agent. Applying an event triggers a `session-state` SSE broadcast — never a
`topology` one, so hook traffic can't make the server rebuild every repo's
worktree list.

One narrow exemption: a tokenless hook is accepted when `wts` names a session
whose stored `hookAuth` is not `true`. Those are sessions whose claude process
was launched with a settings file written before tokens existed — it read that
file once at startup and will never re-read it, so refusing would silently mute a
running agent's status. The exemption clears itself the next time the session is
activated or restored (which rewrites the file and sets `hookAuth`), and it grants
nothing beyond setting that one session's `state`/`activity`. An unknown `wts` gets
no exemption.

---

## Terminal WebSocket (not versioned)

### `ws://<host>:<port>/ws/term?session=<id>&token=<token>&pane=<pane>&cols=<n>&rows=<n>`

Attaches a pty to the session's multiplexer session. `pane=split` attaches to the
independent `<muxName>-split` session instead, creating it if needed. `cols`/
`rows` default to 100×30. An unknown session id closes the socket immediately.

`Host`, `Origin` and the token are all checked **at the upgrade**, before any pty
is spawned; a failure is a plain HTTP `401`/`403` on the handshake, so the socket
never reaches `OPEN`. The session id is *not* an access control — it is a
`crypto.randomUUID()` and unguessable, but the token is what authenticates.

- **Server → client:** raw terminal output.
- **Client → server:** `{"type":"input","data":"…"}` or
  `{"type":"resize","cols":n,"rows":n}`. Anything that isn't valid JSON — and any
  binary frame — is written to the pty verbatim, so a plain-text send works as
  input.

Closing the socket kills the pty, not the multiplexer session; the agent keeps
running and a later connect re-attaches.

---

## Concurrency slots

Running 2–3 features at once means their dev servers cannot share ports. Each
feature gets a slot (0, 1, 2…) while it runs; slot *n* offsets every configured
port of a `concurrency.repos` entry by `n * offsetStep` and sets its slot env
(e.g. `redis__db`) to *n*. Slot 0 is the unshifted default. Frontends that
hardcode a sibling's ports in a gitignored config file get that file rewritten to
the slot's ports before launch.

Notes a client should care about:

- The slot key is the member's **`.worktrees/<name>` basename**, so every repo of
  a feature shares one slot.
- Slots are allocated for all members *before* any launch, so a stack never comes
  up half-started for lack of slots. Exhaustion is `409 { ok: false, error: "no
  free concurrency slot (max N running)" }`.
- Slots are persisted across restarts and reconciled against reality every few
  seconds, so a crashed server's slot is reclaimed on its own.
- `feature.slot` in the state payload is absent when no slot is held.
