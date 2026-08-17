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
| `/api`     | Unversioned alias, byte-identical. Kept for SwiftBar and the web UI.     |

`/api/v1/state` and `/api/state` are the same handler; the tables below list
routes without the prefix, so `/state` means `/api/v1/state` *or* `/api/state`.

Two endpoints are deliberately **not** under either prefix, because their URLs
are baked into things outside the server:

- `POST /hook/:event` — the Claude Code hook receiver (the URL is written into
  every session's generated `--settings` file).
- `ws://…/ws/term` — the terminal WebSocket.

Requests: `application/json` bodies up to 8 MB (`text/*` is also accepted and
arrives as a string — only the hook receiver uses that). A body that is malformed
or over the limit is refused as `400` / `413` in the same `{ error }` shape as
everything else. Responses are JSON unless stated otherwise.

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
SwiftBar, the CLI, the hook script) sends none, and the token covers
those. `Origin: null` is refused. Note WebSockets are exempt from CORS entirely,
so this check on the upgrade is what stops any open browser tab from attaching a
terminal.

**Token** — a 64-hex-char secret generated on first run and stored at
`<stateDir>/token`, mode `0600` (`~/.local/state/worktree-studio/token` by
default; `WT_STUDIO_STATE` moves it). It is stable across restarts, because live
sessions have it baked into hook URLs. Present it as:

- `x-wts-token: <token>` — preferred; what the web UI, the CLI and SwiftBar
  send.
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
| 413    | Body over the 8 MB limit (`{ error: 'request entity too large' }`).          |
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

`text/event-stream`, carrying the live state split into three **named event
types** — the three halves have very different change rates, and a client that
re-renders the world on every Claude tool call pays for the difference:

| Event           | `data:` shape                            | Sent when                                                                                             |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `topology`      | every top-level field except `sessions`/`servers` | The repo→worktree shape or the client's chrome changed: a git rescan (~15 s), a worktree/session mutation, dev-server discovery finding something new, a config save. |
| `session-state` | `{ sessions, servers }`                  | Every state change of any session — i.e. every Claude Code hook, so every tool call. Also rides along with every `topology` frame. |
| `ci`            | `{ ci: { "<sessionId>": [...] } }`       | The PR/CI snapshot changed. Never rides along with anything — see below.                               |

All three events are **full replacements of their half**, never per-item
deltas. A client applies a frame with `state = { ...state, ...frame }`; that is
idempotent, order-independent, and communicates removals for free (a closed
session is simply absent from `sessions`).

On connect the server writes one `topology`, one `session-state` and one `ci`
frame before the client joins the fan-out, so the set is always a **complete
snapshot** and a client can never receive an event that predates its snapshot.
A browser's `EventSource` reconnects on its own; a reconnect is just a new
subscriber, so it re-snapshots and converges rather than drifting.

#### The `ci` event

`data` is `{ ci: { "<sessionId>": [ … ] } }`, where each value is exactly the
`repos` array of `GET /sessions/:id/ci`. Sessions with no promoted repo are
absent. `ci` is **stream-only** — it is not part of `GET /state`, which stays a
synchronous build; a non-streaming client asks `GET /sessions/:id/ci` instead.

It is a separate event rather than part of `session-state` because the two move
on incomparable timescales: `session-state` is re-sent on every tool call, CI
status changes over minutes. Folding it in would re-serialize an unchanged
payload thousands of times an hour and would put a slow, hang-prone `gh`/`glab`
lookup on the path of the hottest broadcast in the server.

The server decides when to refresh (`server/ci.ts`), and **only while at least
one SSE client is subscribed** — with nobody streaming, no forge CLI is spawned
at all. A refresh is triggered by:

- a git rescan, which is how a **commit**, a **push** and a **branch switch**
  reach the server (`server/watch.ts` watches `.git/refs` and `HEAD`);
- `POST /sessions/:id/commit`;
- `POST /group/pr` opening a PR/MR (which also drops the cached "no PR");
- a client subscribing to `/events`;
- a slow safety net (~90 s), for the changes that happen on the forge's side
  and produce no local signal at all — a queued check going green.

Triggers are debounced and floored at 20 s, forge's own cache TTL, so no
worktree+branch pair is ever looked up more often than the previous
client-polling model already allowed. A frame goes out only when the snapshot
actually differs.

Frames are coalesced with an 80 ms debounce. `:hb` comments every 25 s keep the
connection alive.

> Because a session's `{id, state, activity, muxName}` is embedded in
> `repos[].worktrees[].session` and in `features`/`groups`, those copies are
> only as fresh as the last `topology` frame. A client that renders them should
> re-project the live `sessions` onto them after each frame, keyed by session id
> (the SvelteKit client's `stitchSessions()`, in
> `client/src/lib/stores/world.svelte.js`).

---

## The state payload

The single document returned by `GET /state`. Built in `server/state.ts` from
two halves — a *topology* half (`mux` …`groups`) and a *session-state* half
(`sessions`, `servers`) — which `GET /events` streams separately, at their own
rates, as the first two named events above. (The stream's third event, `ci`, is
not part of this document: it is built asynchronously and is stream-only.)

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
| `runConfigs`   | object    | `{ "<repo>": [{ name, cmd, kind, source }] }` — the **manual** run configs from `config.runConfigs`. An editor's own are discovered per worktree, on request: `GET /run-configs`. `{}` when none. |
| `linkProviders`| object[]  | `{ id, match, label, glyph?, idPattern? }` — how a pinned URL is recognised and labelled. `config.linkProviders` first, then the shipped Asana/GitHub/GitLab recognisers, so a user entry can override a shipped one. |
| `sources`      | object[]  | Enabled intake adapters: `{ id, label, needsRepo }`. `id` is what `POST /sessions` takes as `source`. |
| `repos`        | object[]  | Every scanned repo, each with its worktrees. See *Repo*.                                     |
| `features`     | object[]  | Every feature, including single-worktree ones. See *Feature*.                                |
| `groups`       | object[]  | The subset that are real multi-worktree groups: manual groups plus auto groups with ≥ 2 members. Same object shape as `features`. |
| `splitFeatures`| object[]  | One piece of work sitting under two names. See *Split features*.                             |
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
| `depsMissing` | boolean        | A `package.json` with no `node_modules` — the start command would die immediately. |
| `noStartCmd` | boolean         | No `config.start` entry for this repo: the other reason `canStart` is false. |
| `offSlot`    | number[]        | Listening, but on none of the ports this feature's slot expects — the ports it is on instead. Evidence the slot env was never read. |
| `sharedModules` | string \| null | The directory `node_modules` really resolves to, when it is a symlink out of the worktree. The worktree is not isolated: every cache inside it, Vite's `.vite/deps` above all, is shared. |
| `wiredTo`    | object \| null  | Which *feature's* backend this worktree's gitignored config actually points at. `null` when the repo declares no wired ports. See below. |
| `session`    | object \| null  | `{ id, state, activity, muxName }` of the session driving this worktree — a deliberately trimmed view of *Session*. `null` for main checkouts and undriven worktrees. |

`wiredTo` is `{ status, ports, port, feature, repo, path }`. `ports` is every
sibling-repo port the config file names *right now* (read back from disk, not
assumed from the slot); `port` is the one the verdict is about, with `feature` /
`repo` / `path` naming whoever is listening there.

| `status`  | Meaning                                                                       |
| --------- | ----------------------------------------------------------------------------- |
| `mine`    | It points at this feature's own backend. Nothing to do.                        |
| `foreign` | It points at **another feature's** backend, which is named in `feature`. The frontend is talking to a different branch's server — the calls succeed and answer wrongly. |
| `dead`    | Nothing is listening there. The calls fail, but they fail honestly.            |
| `unknown` | The repo is wired but the file named no ports — nothing to check against.      |

A `foreign` hit outranks a matching one: a config naming several ports can have
some land here and some elsewhere, and reporting the good half would hide the
half that is broken.

### Feature

| Field     | Type            | Meaning                                                                       |
| --------- | --------------- | ----------------------------------------------------------------------------- |
| `name`    | string          | The feature identity its members share (the shared worktree name under the default `basename` strategy), or the manual group's name. **The identifier** for every `/group/*` route, and the key a concurrency slot is allocated against. |
| `auto`    | boolean         | `false` for a manual group from `config.groups`, `true` for a discovered one.  |
| `members` | object[]        | Full *Worktree* objects. A manual group member that resolves to nothing is the stub `{ missing: true, ref: "<repo>/<branch-or-name>" }` instead — check `missing` before reading any other field. |
| `session` | object \| null  | The one session driving this feature (the first member that has one), same trimmed shape as `worktree.session`. |
| `slot`    | number          | The feature's concurrency slot, **present only while one is allocated.** Absent means no slot, which is not the same as slot `0`. |
| `color`   | string          | The colour tag set by `POST /features/:name/color`. Absent when untagged.      |
| `ticket`  | string          | The tracker URL set by `POST /features/:name/links`. Absent when unset.        |
| `pins`    | object[]        | `[{ url, label? }]` pinned by hand, same route. Absent when there are none.    |

`color` / `ticket` / `pins` are the raw config, not rendered links: the MR chips
a client shows alongside them are joined in from the `ci` frame, which this
payload deliberately does not carry.

Features are ordered by running-member count descending, then by name.

### Split features

`state.splitFeatures` reports what the naming convention is supposed to prevent:
two features, on the same branch, in different repos — i.e. one piece of work
that failed to group because the worktrees were named differently. Two slots, two
sets of ports, two cards for one job.

```jsonc
[ { "branch": "feature/mfa-totp",
    "features": ["mfa-totp", "totp-mfa"],
    "members": [ { "repo": "api", "wtname": "mfa-totp", "path": "…", "feature": "mfa-totp" },
                 { "repo": "fe",  "wtname": "totp-mfa", "path": "…", "feature": "totp-mfa" } ] } ]
```

**Detection only.** The fix is a manual group (`POST /groups`), and it is the
user's call — grouping on a guess is how the naming convention became
load-bearing without anyone deciding it should be. Manual groups are excluded
from detection (the user has already answered), as are the repos' own default
branches, since every worktree sits on one at some point.

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
| `muxName`         | string          | tmux session name.                                                       |
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

### `POST /features/:name/color`

`{ color }` → tag a feature. One of `teal`, `sky`, `indigo`, `violet`, `magenta`,
`rose`, `olive`, `sand`; anything else is `400 { ok: false, error }`. An empty
`color` **clears** the tag rather than storing a blank, so the stored map only
ever holds live entries. `{ ok: true, color }`, persisted to `config.json` and
broadcast as `topology`.

Its own route rather than a field on `POST /settings`, deliberately: that
endpoint full-replaces the maps it is given, so tagging one feature from a client
holding a stale copy would delete every other tag.

### `POST /features/:name/links`

`{ ticket?, pins? }` → a feature's tracker URL and hand-pinned links.
`{ ok: true, links }` with the merged entry (`{ ticket?, pins? }`), or
`400 { ok: false, error: 'no feature named' }`.

Keyed by **feature**, not by session: a ticket outlives the agent working on it,
and `session.sourceUrl` died whenever the session did. Only the fields present
are touched; an empty `ticket` removes it, and an entry left with nothing in it
is dropped entirely.

`pins` is `[{ url, label? }]` and is a full replace. A pin without a `url` is
dropped rather than stored as a link to nowhere, and so is one whose scheme a
browser should not follow — these are rendered into an `href` in the page that
holds the boot token, so a stored `javascript:` pin would be one click from
reading it out. The client refuses to render those; this is the half that stops
them being written down, because `config.json` outlives any client and is also
edited by hand.

### `POST /groups`

`{ name, members }` → create or update **one** manual group.
`400 { ok: false, error: 'name and at least two members are required' }` below
two members: one worktree is already a feature on its own, so a one-member group
is a row that changes nothing. `{ ok: true, groups }` with the whole list, and a
`topology` broadcast — two features becoming one changes the payload, so it is
rebuilt rather than merely re-sent.

This is what acts on `state.splitFeatures`. A single-group write on purpose: the
user is answering one question about one card, and `POST /settings`' `groups`
field is a full replace, so a payload built from that card could delete every
group they had made by hand.

### `GET /fs/dirs?path=<dir>`

Directory listing for the base-directory picker.
`{ path, parent, repoCount, entries: [{ name, path, repo }], error? }` — `parent`
is `null` at the filesystem root, `repo` says the entry is a git checkout, and
`repoCount` is how many of the children are. Defaults to the home directory.

Never fails: an unreadable or missing path answers with the home directory's
listing plus an `error`, because a picker that goes blank on a fat-fingered path
is one you cannot get out of without closing it.

The daemon lists it because the daemon is the thing that will scan it — a browser
cannot hand back a path (`webkitdirectory` uploads contents,
`showDirectoryPicker()` returns a handle with no path). It discloses directory
**names** and repo-ness only: no file names, no contents, no sizes.

---

## Sources (session intake)

### `GET /sources`

The enabled adapters — identical to `state.sources`.

### `GET /sources/:source/items?repo=<name>&q=<query>`

Pickable items from one adapter. `{ ok: true, items: [{ id, title, subtitle }] }`,
or `{ ok: false, error, items: [] }` if the adapter is disabled or threw. Always
`200`. `repo` is required by adapters whose `needsRepo` is true.

### `POST /sources/asana/verify`

`{ token }` → check a token the user has just typed and say who it belongs to:
`{ ok: true, … }` with Asana's own answer, or `400 { ok: false, error }` (a
rejected token is reported as `Asana rejected that token`, since that is much the
commonest thing to get wrong).

Takes the token in the **body**, and persists nothing: this is asked *before*
anything is saved — proving the token works is what the user is doing when they
press Connect.

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

### `POST /sessions/:id/restart-terminal`

Kill the multiplexer session and relaunch it, resuming the same conversation —
for a pty that has wedged, without losing the transcript. Answers exactly as
`activate` does (`{ ok: true }`, or `{ ok: false, error }` including `no such
session`).

Deliberately quiet in between: no broadcast is sent between the kill and the
relaunch, so the session never renders as `stopped` for the length of it. The
flicker is the thing this verb exists to avoid.

### `DELETE /sessions/:id?kill=false`

End a session for good: stop the dev servers of every worktree it owns, release
their concurrency slots, kill the multiplexer session (unless `kill=false`), and
delete the record and its generated settings file. Worktrees are **kept** — use
`/group/delete` to remove those. `{ ok: true }`, or `{ ok: false, error }` if unknown.

This one answers `200` for an unknown session rather than the `404` its neighbours give.
That is deliberate and worth stating rather than quietly fixing: deleting something that
is already gone is the outcome the caller wanted, and a menubar or CLI retrying a delete
should not have to treat "it was not there" as a failure. The `error` is present so the
reason is never silent.

### Tabs

| Route                              | Body               | Returns                                    |
| ---------------------------------- | ------------------ | ------------------------------------------ |
| `POST /sessions/:id/tabs`          | `{ title?, cmd? }` | `{ ok, id }` — new multiplexer window.       |
| `POST /sessions/:id/select-tab`    | `{ tab }`          | `{ ok }`                                    |
| `POST /sessions/:id/rename-tab`    | `{ tab, title }`   | `{ ok, title }`                             |
| `POST /sessions/:id/close-tab`     | `{ tab }`          | `{ ok }`; refuses to close the last tab.    |

`tab` is the multiplexer's **window id** (`@7`), not a position. tmux runs with
`renumber-windows on`, so an index is a slot that is reassigned whenever an earlier
window closes — an index held across a close names a different terminal. `index` is
still accepted as a legacy positional form.

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
`paths` it stages everything (`git add -A`). `message` is required (`400`), and an
unknown session is a `404` like every other session route.

### Structured diff and hunk staging

The routes above answer "what changed" as raw patches. These four answer it as a
*model* — files → hunks → lines, with left/right rows already aligned — and let a
client stage or unstage one hunk at a time. `server/routes-review.ts`.

| Route                                | Returns                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| `GET /sessions/:id/diff`             | `{ repo, worktreePath, sha, files }`                                |
| `GET /sessions/:id/hunks`            | `{ file, untracked, unstaged, staged }`                             |
| `POST /sessions/:id/hunks/stage`     | `{ ok, file, hunks, untracked, unstaged, staged }` or `{ ok: false, error }` |
| `POST /sessions/:id/hunks/unstage`   | same shape                                                          |

All four resolve the worktree the same way: `?repo=<name>` on the GETs, `repo` in
the body on the POSTs. `repo` may be omitted when exactly one of the session's repos
**has a worktree** — which is not the same as owning one repo, since a multi-repo
session whose other repos are not yet promoted also qualifies. Otherwise it is
required (`400 { error: "repo is required" }`, or `400 unknown repo '<name>'`).
Unknown session → `404`.

#### `GET /sessions/:id/diff?repo=<name>&sha=<sha>`

The same set of files `commit-detail` returns, each carrying **both** the raw
patch and the parsed model:

```jsonc
{ "repo": "api", "worktreePath": "/code/api/.worktrees/feat-a", "sha": "uncommitted",
  "files": [
    { "file": "src/a.js", "status": "M", "added": 12, "deleted": 3,
      "diff": "diff --git a/src/a.js …",     // raw unified diff, unchanged
      "parsed": {
        "path": "src/a.js", "oldPath": "src/a.js", "newPath": "src/a.js",
        "status": "modified", "binary": false, "added": 12, "deleted": 3,
        "hunks": [
          { "index": 0, "header": "@@ -1,6 +1,7 @@ function a() {",
            "oldStart": 1, "oldLines": 6, "newStart": 1, "newLines": 7,
            "section": " function a() {", "added": 1, "deleted": 0,
            "lines": [ { "type": "context|add|del", "text": "…", "oldLine": 1, "newLine": 1 } ],
            "rows":  [ { "type": "context|add|del|change", "left": 0, "right": 0 } ] } ] } }
  ] }
```

The `parsed` object above shows the fields a renderer needs, not every field:
`header` (the raw `diff --git`/`index`/`---`/`+++` lines, kept verbatim so a subset
can be re-emitted as a valid patch), `oldMode`/`newMode`/`similarity`, and per-line
`noNewline`/`noNewlineText`/`bare` are also present. `parsed` is `null` for a file
with no diff text at all. `lines` renders unified;
`rows` renders side-by-side and references `lines` **by index**, so neither copy of
the text exists twice. A `change` row pairs a removal
with the addition that replaced it; one-sided rows carry `null` on the other side.

`sha` defaults to `uncommitted` (the working tree). It is validated before it
reaches a git argv — anything that is not a hex object name or the literal
`uncommitted` is `400 { error: "sha must be a hex object name or \"uncommitted\"" }`,
never a 500. `sha` and `file` are `String()`-coerced first, so a repeated param
(`?sha=a&sha=b`, which parses to an array) becomes the comma-joined string `"a,b"`
and is rejected by that same validation — a `400`, never a `TypeError` 500.

Two shapes cannot be modelled and say so instead of being mis-parsed:
`parsed.binary` is `true` for a binary file, and `parsed.unsupported: "combined"`
marks a merge diff (`@@@`). `parsed.modeOnly` marks a permission-only change.

#### `GET /sessions/:id/hunks?repo=<name>&file=<path>`

One working file, split the way staging needs it. `file` is required (`400`).

- `unstaged` — index → worktree. These hunks can be **staged**.
- `staged` — HEAD → index. These hunks can be **unstaged**.
- Either side is `null` when there is nothing on it. `untracked` is `true` for a
  file git has never seen; its `unstaged` side is the synthesized `/dev/null → file`
  patch, so staging a hunk of a brand-new file works.

Each side has the `parsed` shape above. The pre-image is deliberately the **index**,
not HEAD, which is what makes a partially-staged file work — the same choice
`git add -p` makes.

#### `POST /sessions/:id/hunks/stage` · `POST /sessions/:id/hunks/unstage`

```jsonc
{ "repo": "api", "file": "src/a.js", "hunks": [0, 2], "expect": ["@@ -1,6 +1,7 @@ …"] }
```

`hunks` is an array of indexes **into the matching side** of the `GET …/hunks`
payload — `stage` indexes `unstaged`, `unstage` indexes `staged`. `hunks: 0` and
`hunk: 0` are both accepted as the single-hunk shorthand.

`expect` is optional and is the `@@` header the caller believes each selected hunk
has. The diff is re-read server-side, so a file that moved between render and call
would otherwise stage the *wrong* hunk silently; with `expect` the request is
refused instead.

Two things about `expect` a caller has to get right, because getting them wrong
fails **silently** rather than loudly: it is only honoured when it is an **array**
(a bare string is ignored, guard and all), and it is matched **positionally** —
`expect[i]` against the hunk named by `hunks[i]` — so a `null`/absent entry skips
the check for that one hunk.

On success the response carries the freshly re-read `untracked`/`unstaged`/`staged`
for that file, so a client never needs a follow-up GET, and a `session-state` frame
is scheduled on the SSE stream (the index moved; the topology half did not).

Every refusal is a **`400`, not a `500`** — these all mean "the request no longer
matches the repo", which is the caller's to resolve:

| `error`                                                     | Cause                                  |
| ----------------------------------------------------------- | -------------------------------------- |
| `file is required`                                           | no `file`                              |
| `no <staged\|unstaged> changes for this file`                | nothing on that side                   |
| `no hunks in the <side> diff for this file`                  | a diff with no hunks (see below)       |
| `hunks must be indexes into the <side> diff (0…<last>)`      | out of range, not an integer, **or an empty selection** (no `hunks` and no `hunk`) |
| `the diff changed since it was loaded — reload and try again`| `expect` mismatch                      |
| `binary file — stage or unstage the whole file instead`      | binary                                 |
| `mode-only change — stage or unstage the whole file instead` | permission-only change                 |
| `combined (merge) diff — hunk staging is not supported`      | `@@@`                                  |
| git's own message, else `patch does not apply`               | `git apply --check` refused the patch  |
| git's own message, else `git apply failed`                   | the apply itself failed                |

Staging is all-or-nothing: the patch is `git apply --check`ed before it is applied,
because `git apply` is not atomic across files and a half-applied patch leaves the
index in a state nobody asked for.

> This sits **alongside** the file-level staging in `POST /sessions/:id/commit`
> (its `paths` argument), it does not replace it — binary and mode-only changes can
> only be staged whole, which is exactly what the errors above say.

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
- Results are cached ~20 s per worktree+branch, shared with the push feed. With
  neither CLI installed the route answers immediately with `hasPR: false` for
  every repo. Each lookup carries a 20 s timeout, so a hung CLI is killed rather
  than left to hang the request.

`404` for an unknown session.

> This route is the **on-demand** answer, for SwiftBar and anything else
> that does not hold a stream open. Streaming clients should not poll it — the
> same data is pushed as the `ci` SSE event, refreshed by the server on the
> events that change it.

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

### `POST /worktrees/install-deps`

`{ worktreePath }` → run `npm install` in a worktree whose `node_modules` is
missing (`worktree.depsMissing`), which is the other reason a startable repo
cannot start.

The response is the **outcome**, not an acknowledgement — `{ ok: true, log }` or
`{ ok: false, error, log? }`, where `log` is the install log `GET /servers/logs`
cannot reach (it is keyed by run, not by worktree). This means the request is
open for as long as the install takes, deliberately: a client that got an
acknowledgement could only guess at success from a later sweep, and the npm exit
code is the thing worth reporting. `error` is `no such worktree`,
`no package.json here`, `already installing`, or `npm install exited <code>`.

`canStart` / `depsMissing` change as a result, so a `topology` frame follows.

---

## Reviews

### `POST /reviews/checkout`

`{ repo, branch, number, title?, url? }` → check somebody else's merge request
out and point an agent at it. `{ ok: true, session, worktree: { name, path },
reused }`, or `400 { error }` for a missing field, an unknown repo, or a git
failure.

The only route that creates a worktree for a branch that is not yours. It is cut
from `origin/<branch>` (fetch, then a local branch at the remote tip) because the
MR's source branch lives on the remote, and the worktree is named
`review-<number>` rather than after the branch: `feature/mfa-totp` would collide
by name with the worktree you already have and be auto-grouped into the same
*feature* as your own work.

An existing `review-<number>` worktree is not a failure — it is the one you made
last time, and it is reused (`reused: true`). The adopted session is seeded with
a review brief that tells the agent to report rather than change the code.

---

## Orphans (reinstating a closed session)

Closing a session deletes Studio's pointer to it; the **conversation** belongs to
Claude Code and stays on disk. These two routes find those conversations and
bring one back.

### `GET /orphans`

`{ orphans: [ { worktreePath, repo, name, branch, claudeSessionId, lastModified,
conversations, recoverable, reason? } ] }` — every worktree with a transcript and
no live session, newest conversation per worktree (`conversations > 1` means one
was picked). `recoverable: false` carries the `reason`.

Candidates are worktrees that exist right now *and* the paths that branches with
no worktree **would** occupy under `config.worktrees.layout`. The second half is
what makes a deleted worktree findable at all: the lookup only goes forwards, from
a path to its transcript directory, because Claude's directory slug is lossy and
cannot be walked back to a path. Branches are enumerated lazily, here, rather than
on every scan — that would be a git call per repo on every file change to answer
a question nobody asks until they open this list.

### `POST /orphans/reinstate`

`{ worktreePath }` → recreate the worktree if it is missing, then adopt it with
`--resume`. `{ ok: true, session }`.

- `400 { ok: false, error: 'worktreePath is required' }`, or a git failure.
- `404` — nothing to reinstate at that path, or no conversation was found for it.
- `409` — not recoverable (the `reason` from `GET /orphans`), or a session for
  that worktree is already opening.

It refuses rather than improvises when the branch is gone: recreating then would
give an empty branch off the default with a transcript attached — an agent
resuming into a directory that does not hold the code it is discussing. When the
branch is there, the worktree is recreated **at the path the transcript is keyed
to**, which is what makes `--resume` find it.

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

## Run configurations and runs

A worktree's editor run configurations — JetBrains, VS Code — read out of the
worktree, and what happens when you run one.

### `GET /run-configs?worktreePath=<path>&repo=<name>`

`{ configs: [ { name, cmd, kind, source, file, env? } ] }`, where `kind` is
`server` (long-lived) or `task` (finite), and `source` is `jetbrains` / `vscode`
— or `manual` for an entry from `config.runConfigs[repo]`, whose `file` is
the config file. Deduped by name, discovered entries winning a clash with a
manual one, then JetBrains → VS Code among themselves. `400` without a
`worktreePath`.

**Discovered on request, not imported and not part of the topology payload.** An
imported copy goes stale the moment the editor's config changes, and the topology
half is broadcast on every git rescan — putting a per-worktree directory scan
there would cost a handful of stats per worktree per broadcast for something only
read when a menu is opened.

### `POST /run-configs/run`

`{ repo, worktreePath, name }` → run one. `400` for a missing field, `404
{ error: "no run configuration named '<name>'" }` if the worktree no longer
declares it. What comes back depends on its `kind`:

- `server` → it is launched and tracked exactly like a dev server (a pid, a log,
  reachable by Stop stack), on the feature's concurrency slot: the `start`
  response plus `kind: 'server'`, or `409 { ok: false, error }` if no slot is
  free. A run config names no ports, so there is nothing to pre-check — discovery
  finds it once it binds.
- `task` → `{ ok: true, kind: 'task', runId }`, and it becomes a *run* below.

A finite command used to open a tmux tab. That works, but it makes you read raw
ANSI in a pane competing with the agent's own tabs, it answers none of the
questions you have about a test run, and it needs a session to exist — which a
feature may not have. A run needs only a worktree.

### Runs

| Route                     | Returns                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `GET /runs`               | `{ runs: [ <Run> ] }` — all of them, or `?worktreePath=` for one worktree's |
| `GET /runs/:id/log`       | `{ offset, text, size, skipped? }` — same tail contract as `/servers/logs` |
| `POST /runs/:id/stop`     | `{ ok: true }`, or `{ ok: false, error: 'no such run' }`         |
| `POST /runs/:id/rerun`    | `{ ok: true, run }` — a **new** run                              |
| `DELETE /runs/:id`        | `{ ok: true }`; `{ ok: false, error: 'still running — stop it first' }` |
| `POST /runs/:id/to-agent` | see below                                                        |

A *Run* is `{ id, name, repo, worktreePath, cmd, status, startedAt, endedAt?,
exitCode?, log, env?, pid? }`. `status` is `running` | `passed` | `failed` |
`stopped`. `exitCode` is null for a run killed before it reported one, and `pid`
is absent after a daemon restart — a pid from a previous process is not ours to
signal. The last 60 finished runs are kept: history is for "what did the last one
say", not an archive.

`stop` signals the process **group**, so a test runner's children do not outlive
it. `rerun` re-executes the recorded `cmd` and `env` rather than re-resolving the
configuration by name — a history row says "run *that* again", so it cannot fail
because the config was renamed, and cannot quietly run something else because the
file changed. Use `POST /run-configs/run` for whatever the config says today.

### `POST /runs/:id/to-agent`

Hand a finished run to the agent working in its worktree: one line naming the
configuration, how it exited, and **the path to its log** — not the output.

`{ ok: true, sessionId, message }`. `400 { ok: false, error }` for `no such run`,
`that run is still going — wait for it to finish`, or `no agent is attached to
that worktree`. `200 { ok: false, skipped: true, reason, sessionId, message }`
means the agent is there but was not ready — a state the client should explain,
not a failure it should report.

The session is looked up **from the run's worktree** rather than named by the
caller: one session owns a worktree, and letting a stale tab pick the target
would send a failure to whichever agent it last had selected.

A path, not a paste, for two reasons. Text is written into the pane and Enter is
pressed separately, so a body containing newlines submits at the first one — a
stack trace would arrive as fifty half-messages, each interrupting the agent
again. And the log is already on disk: the agent reads *all* of it rather than
whatever tail we guessed was enough.

---

## Features and groups

Every route takes `{ group: "<feature name>" }` and answers `404 { error: 'no
such feature' }` if the name matches neither a feature nor a group. Members that
don't resolve (`missing`) are skipped throughout. The one exception is the read
below, `GET /group/:name/commits`, which has no body to put the name in.

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
settle) and continue. Then:

```jsonc
{ "ok": false, "started": 2, "total": 3, "failures": [ { "repo": "fe", "error": "port 3030 already in use (pid 991)" } ] }
```

`ok` is `true` only when **every** member that was going to start did —
i.e. `failures` is empty. A group with nothing to start is `{ ok: true,
started: 0, total: 0, failures: [] }`, which is a no-op rather than a failure.
`started`/`failures` still carry the detail for a partial result.

`409 { ok: false, error }` if a slot can't be allocated — checked for every
member before any of them launches, so a partial stack is never started for lack
of slots.

The `needsConfirm` response above keeps `ok: true`: nothing failed, the server is
asking a question. Clients must check `needsConfirm` before `ok`.

### `POST /group/stop`

Stop every running member and release the feature's slot. `{ ok: true }`.

### `POST /group/restart`

Restart every member that is running or `canStart`, reusing the feature's
existing slot. `{ ok: true }`, or `409` if a slot can't be allocated.

### `POST /group/update`

`{ group, stopServers? }` → bring every member of the feature up to date with its
base, by **rebase** (`git rebase origin/<default branch>`, the same ref
`/api/worktrees` cuts new branches from and the drift feed measures against).

A dev server running in a worktree being rebased is a hazard — a bundler watching
a tree mid-replay serves whatever it happened to read — so while any member is
running the route answers, without touching anything:

```jsonc
{ "ok": true, "needsConfirm": true, "running": [ { "repo": "api", "path": "…", "wtname": "feat-x" } ] }
```

Repeat with `stopServers: true` to stop them first. They are **not** restarted
afterwards: the base can bring a new lockfile with it, so `/group/start` (which
re-checks whether a member can start) is the next step.

Per member, and refused before anything is touched when the worktree is detached,
already mid-rebase, has uncommitted tracked changes, or when the drift read
already knows which files will conflict. A rebase that fails anyway is
`--abort`ed, so a member is never left mid-rebase.

```jsonc
{ "ok": false, "updated": 1, "total": 2, "stopped": ["api"],
  "results": [ { "repo": "api", "base": "origin/main", "ok": true, "updated": true, "behind": 27 },
               { "repo": "fe", "base": "origin/main", "ok": false, "updated": false, "behind": 4,
                 "error": "3 file(s) would conflict with origin/main — rebase by hand: …",
                 "conflicts": ["src/app.ts"] } ] }
```

Top-level `ok` is true only if *every* member succeeded. An already-current member
is `{ ok: true, updated: false, behind: 0 }`.

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

### `POST /group/push`

`{ group }` → push every member's branch to origin with the same
`git push -u origin <branch>` `/group/pr` uses. No forge CLI is involved. This is
the verb that clears the ship bar's "has N unpushed commit(s)".

```jsonc
{ "ok": false, "pushed": 1, "total": 2,
  "results": [ { "repo": "api", "ok": true, "pushed": true, "upstreamSet": true },
               { "repo": "fe", "ok": false, "pushed": false,
                 "error": "rejected: origin/feature/x has commits this branch does not. Update from base, then push again — Studio does not force-push" } ] }
```

- `upstreamSet` — the branch had no upstream and `-u` gave it one (a first push).
- `nothingToPush` — origin already had every commit. `ok: true`, `pushed: false`.
- a non-fast-forward rejection is reported and never retried with `--force`;
  `/group/update` is the fix.

Top-level `ok` is true only if *every* member succeeded. A push that actually sent
commits invalidates the CI cache, so the MR pill re-looks immediately.

### `POST /group/pr`

For each member: push the branch (`git push -u origin <branch>`), then open a PR
with `gh pr create --fill`, falling back to `glab mr create --fill --yes`.

A member whose push is rejected (no `origin`, no upstream, non-fast-forward) is
reported as `{ repo, error: "git push failed: <git's own line>" }` and no PR is
attempted for it — the branch isn't on the forge, so creation could only fail
with a downstream symptom.

```jsonc
{ "ok": true, "results": [ { "repo": "api", "url": "https://github.com/…/pull/412" },
                           { "repo": "fe",  "error": "glab: not authenticated" } ] }
```

Top-level `ok` is true only if *every* member got a URL. Unlike `/sessions/:id/ci`,
creation shells out whether or not the CLI was detected at startup.

The reported `error` is the failure that actually explains the outcome, in this
order:

1. the first stderr line from the first **installed** provider that refused
   (GitHub before GitLab — the order they're tried in);
2. `"gh/glab unavailable or failed"` when an installed provider failed without
   saying anything;
3. `"no forge CLI installed — install gh (GitHub) or glab (GitLab)"` when
   neither CLI exists on the machine.

A provider whose CLI isn't installed exits with an empty stderr, and that
silence never replaces the reason from one that ran.

### `GET /group/:name/commits`

The `GET /sessions/:id/commits` rollup for a **feature** rather than a session:
`{ repos: [ … ] }`, the same shape and the same `base..HEAD` rules, one entry per
member with a path. `404 { error: 'no such feature' }`.

That route is keyed on a session, so a feature with no agent — the exact case the
dock's feature pane exists for — could not answer "what is in here, and is it
merged?" without starting one. Same shape, so a client renders both the same way.

---

## Transcripts (search)

Claude Code appends a JSONL transcript per session to
`~/.claude/projects/<slugified-cwd>/<claudeSessionId>.jsonl`. These routes index
and search it. `server/transcript-routes.ts`.

One thing to know before reading the shapes: **the index is optional, but the
fallback is not uniform.** Storage is `node:sqlite` (built into Node 22).
`backend` always says which layer answered:

| `backend` | when | search is |
| --- | --- | --- |
| `sqlite-fts5` | normal | FTS5 `MATCH`, ranked |
| `sqlite-like` | sqlite present, FTS5 missing | `LIKE` over the same table |
| `file-scan` | `node:sqlite` itself unavailable | substring scan of the files |

Note that a missing FTS5 does **not** mean file scanning — it is still sqlite.
Only the two search routes fall back to `file-scan`; `POST /transcripts/reindex`
simply refuses (`ok: false`).

Indexing is incremental — the byte offset of the last pass is remembered and only
appended bytes are read — and is triggered by the `Stop` / `SubagentStop` /
`SessionEnd` hooks. A burst of hooks (parallel subagents) coalesces into one
follow-up pass. Both search routes refresh the session they are scoped to first, so
a caller never misses the last turn because no hook has fired yet;
`GET /sessions/:id/transcript` does not (it only locates the file).

A session that is deleted keeps its indexed messages: the corpus is an archive, and
"which session touched `helpers/mfa.js`" is asked most often about finished work.

A `claudeSessionId` that is not a uuid is refused before it is joined into a path;
it arrives from a hook payload, and `../../..` would otherwise escape the
transcript root.

### `GET /transcripts/status`

Index health.

```jsonc
{ "ready": true, "backend": "sqlite-fts5", "fts5": true,
  "file": "~/.local/state/worktree-studio/transcripts.db", "error": null,
  "sessions": 12, "messages": 48213 }
```

### `GET /sessions/:id/transcript`

Which transcript a session maps to, and whether the server can see it. Useful on
its own when a session turns up no hits — it says *why*.

```jsonc
{ "session": { "id": "…", "title": "…", "feature": "feat-a", "branch": "feature/a",
               "repo": "api", "active": true, "state": "working" },
  "claudeSessionId": "3f2a1b4c-…", "found": true,
  "file": "/Users/d/.claude/projects/-Users-d-code-api/3f2a1b4c-….jsonl",
  "cwd": "/Users/d/code/api", "slug": "-Users-d-code-api",
  "projectsRoot": "/Users/d/.claude/projects" }
```

When `found` is `false` the payload carries `reason` and omits `file`, `cwd` and
`slug` (`session has no claudeSessionId yet` · `claudeSessionId is not a uuid` ·
`no projects dir at <path>` · `transcript not found`). `viaScan: true` means the
file was found by scanning the project dirs rather than at the expected slug — a
promote whose `/cd` never landed does this; in that case `cwd` is present but
`null`, because the directory it was found in is not one this session claims.
`404` for an unknown session.

### `GET /transcripts/search`

Full-text search across every session Studio manages — deliberately *not* across
all of `~/.claude/projects`.

| Param             | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `q` (or `query`)  | the search text. Empty → `{ query: "", hits: [], total: 0, backend }`, not an error. |
| `session`         | scope to one session id (also refreshes that session's index first) |
| `role`            | `user` / `assistant`                                              |
| `since`           | epoch ms floor on the message timestamp                           |
| `order`           | `rank` (default) or `recent`                                      |
| `limit`           | 1–200, default 30                                                 |

**Not every filter survives every backend**, and a silently ignored filter is worse
than a rejected one, so: on `file-scan` only `q`, `session` and `limit` are honoured
(`role`, `since` and `order` are dropped); on `sqlite-like` results are always
ordered newest-first, so `order=rank` is ignored. Check `backend` before trusting a
filter.

```jsonc
{ "ok": true, "backend": "sqlite-fts5", "query": "port already in use",
  "total": 3,
  "hits": [ { "sessionId": "…", "uuid": "…", "role": "assistant",
              "model": "claude-opus-5", "ts": "2026-07-27T…", "tsMs": 1785…,
              "gitBranch": "feature/a", "sidechain": false,
              "snippet": "…«port already in use» (pid 991)…",
              "session": { "id": "…", "title": "…", … } } ] }
```

`total` is the length of *this page*, not a corpus count. `snippet` carries FTS5's
`«` `»` highlight markers on the `sqlite-fts5` backend only. `sidechain` marks a
subagent's message. `ok` is present only on the sqlite backends — the `file-scan`
and empty-query responses omit it, so branch on `backend`, not on `ok`.

The query is **not** an FTS5 expression. It is tokenized as `"quoted runs"` plus
bare whitespace-separated words, each token is re-quoted as a literal phrase, and
the phrases are ANDed. So `OR`, `NEAR` and `*` are searched for rather than
executed, and a double-quoted run stays one multi-word phrase. Note that `"`
characters are **stripped**, not searched for — an unbalanced quote disappears
rather than matching a literal quote.

A repeated param (`?q=a&q=b`) collapses to its first value rather than erroring.
`sessionId` is accepted as an alias for `session`.

### `GET /sessions/:id/transcript/search`

The same search scoped to one session, and the session's index is refreshed
first. Takes `q`/`query`, `limit`, `order` (no `role`/`since`). Returns the same
shape plus a top-level `session`, and omits the per-hit `session` meta — the caller
already knows whose it is. `404` for an unknown session.

Two `file-scan` caveats: hits carry no `sessionId` either (they come straight off
the file), and when the transcript cannot be found the response is
`{ query, backend, hits: [], total: 0, reason }` with **no** top-level `session`.
On that backend `limit` clamps to 1–500, not 1–200.

> Prefer the global endpoint with `?session=<id>` when rendering a results list:
> it carries per-hit session meta, which is what lets a hit from an unknown
> session render at all.

### `POST /transcripts/reindex`

`{ session?, full? }` → re-index one session or all of them. `full: true` (or
`?full=1`) discards the stored byte offset and re-reads from the top, which is
what to use when a transcript was rewritten under the server.

```jsonc
{ "ok": true, "full": false,
  "results": [ { "session": "…", "ok": true, "file": "…", "added": 12,
                 "offset": 3418822, "size": 3418822,
                 "malformedLines": 0, "truncatedTail": false } ],
  "status": { … } }
```

A per-session `ok: false` carries `reason`: `transcript vanished`,
`claudeSessionId is not a uuid`, `no session id`, or the index's own open error
(typically `node:sqlite unavailable (<require error>)` rather than the bare
`index unavailable`). `{ ok: true, skipped: 'in flight' }` means a pass for that
session was already running — not a failure. `upToDate: true` means there were no
new bytes, the cheap and normal outcome.

Unlike every other per-session route, naming a session that does not exist is
**not** a `404`: `{ session: "nope" }` filters to nothing and answers
`200 { ok: true, results: [] }`.

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
