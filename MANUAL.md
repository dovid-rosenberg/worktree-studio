# Worktree Studio — Manual

A local web app that unifies your whole feature workflow into one cockpit: start a
real **Claude Code** session, promote it into a **git worktree**, run its **dev
servers**, review the **diff**, commit, open a **PR**, and manage many features at
once — including **running 2–3 features concurrently** on isolated ports.

It replaces the loose collection of `wt` scripts, terminal tabs, and a menubar
dashboard with a single page at **http://127.0.0.1:7788**.

---

## Table of contents

1. [Concepts & glossary](#concepts--glossary)
2. [Install & run](#install--run)
3. [The feature lifecycle](#the-feature-lifecycle) — the spine of the tool
4. [Feature reference](#feature-reference)
5. [Views: Work vs Fleet](#views-work-vs-fleet)
6. [Keyboard shortcuts](#keyboard-shortcuts)
7. [Running features concurrently (slots)](#running-features-concurrently-slots)
8. [Configuration reference](#configuration-reference)
9. [Command-line interface](#command-line-interface)
10. [HTTP & WebSocket API](#http--websocket-api)
11. [Files & state on disk](#files--state-on-disk)
12. [Claude Code integration](#claude-code-integration)
13. [Troubleshooting](#troubleshooting)
14. [Architecture](#architecture)

---

## Concepts & glossary

| Term | Meaning |
|------|---------|
| **Session** | A live Claude Code process running inside a tmux session, tracked by Studio with an id like `s_5ii11`. This is where you actually talk to Claude. |
| **Repo** | One of your git repositories under `baseDirs` (e.g. `accept-blue`, `merchant-v3`, `ab-iso-fe`, `ab-su`). Discovered automatically. |
| **Worktree** | A git worktree checked out on a feature branch, living at `<repo>/.worktrees/<name>` by default (`worktrees.layout` — see [docs/config.md](docs/config.md)). Isolated working copy — you can have many per repo. |
| **Promote** | Turn a session that started in the main checkout into one bound to a fresh worktree. The **same Claude conversation continues** (see [Claude integration](#claude-code-integration)). |
| **Feature** | A named unit of work, identified by its worktree name. One feature can span multiple repos (BE + FE) — they’re grouped by sharing the same worktree name. |
| **Slot** | A concurrency offset (0, 1, 2…) that gives a feature its own ports and Redis DB, so multiple features run at once without colliding. |
| **Dev server** | A running `npm run dev` (or configured command) for a repo’s worktree. Studio discovers, starts, stops, and tails these. |
| **Multiplexer** | The terminal backend. Studio is **tmux-only** (socket `-L wt-studio`); sessions are named `wts-<name>-<id>`. |
| **Dock** | The main panel of a session: the terminal, plus the Changes and Logs tabs. |
| **Intake** | How a new session is seeded: free text, a GitHub issue/PR, a GitLab issue/MR, or an Asana task. |

---

## Install & run

**Requirements:** Node.js, `tmux`, and the `claude` CLI on your PATH. Optional: `gh`
(GitHub) / `glab` (GitLab) for PR/CI features; an editor CLI (WebStorm/Zed).

```bash
cd ~/worktree-studio
npm install          # runs postinstall: fixes node-pty perms + vendors xterm
npm start            # → http://127.0.0.1:7788
```

Or via the CLI (same thing): `wt-studio`. Run tests with `npm test`.

On first run Studio writes a default config to `~/.config/worktree-studio/config.json`
and scans `baseDirs` (default `~/Desktop/ab-code`) for git repos.

---

## The feature lifecycle

This is the core loop the whole product is built around.

### 1. Start a session (intake)
Click **＋ New session** (or `⌘N`). Pick a repo and seed the work:
- **Free text** — type what you want; it’s handed to Claude as the opening prompt.
- **GitHub / GitLab / Asana** — pick an issue/PR/MR/task; its title + body seed the session.

The session starts in the repo’s **main checkout**. You can just talk to Claude, explore,
ask questions — no worktree is created yet. (Not every question deserves a branch.)

### 2. Promote to a worktree
When the work is real, click **⤴ Promote** (or `⌘↵`). Studio:
- Creates `<repo>/.worktrees/<name>` on a fresh feature branch off the default branch,
- Copies your gitignored local config into it (see `copyPatterns`),
- Sends the live Claude session the **`/cd <worktree>`** command, which relocates *both*
  Claude’s working directory **and** its conversation transcript into the worktree.

The same conversation continues seamlessly — and every future resume opens directly in
the worktree. If your main checkout has uncommitted changes, you’re warned first (they
stay in main, they don’t move to the worktree).

### 3. Add more repos to the feature (optional)
A feature often spans BE + FE. Add another repo either from the UI or from inside the
Claude session:

```bash
wt-studio add-repo merchant-v3
```

Studio creates a same-named worktree in that repo and grants the session access via
`/add-dir`. All repos of a feature share the worktree **name**, which is how they group.

### 4. Run the dev servers
In the session’s **server bar** (or Fleet), **Run all** / **Run stack** starts the
configured dev servers for the feature’s repos. Running frontends get an **Open ‹repo› ↗**
button that opens `localhost:<port>`. Stop/restart from the same place.

### 5. Review, commit, PR
Open the **✎ Changes** tab (or `⌘D`):
- The left column lists the branch’s **commits** (base..HEAD) grouped by repo, newest
  first, with sha/author/time/± — plus each repo’s **uncommitted** working changes pinned
  at the top.
- Click a commit to see **all its files’ diffs**; the file list stays visible, and clicking
  a file focuses **just that file’s** diff.
- Select an **Uncommitted** entry to write a commit message and **Commit** / **Commit & PR**
  (with amend) — it targets that repo’s worktree.

### 6. Close or delete the feature
From **Fleet → ⋯**:
- **Close feature** — stops servers, deactivates the session, **keeps** the worktree/branch.
- **Delete feature** — stops servers, kills the session, **removes** the worktree(s)
  (optionally the branch too).

Deleting a session (🗑) also stops its servers and frees its concurrency slot.

---

## Feature reference

### Sessions & terminals
- **Live embedded terminal** (xterm.js) with two-way I/O to the tmux session.
- **Tabs** per session (`claude`, `shell`, …) — add, select, close tabs.
- **Pop-out** — open the same live session in a native macOS terminal window (grouped
  tmux session; both stay in sync).
- **⊟ Split** (a sub-feature of the terminal) — open a **second, independent terminal**
  beside the primary. It’s a standalone tmux session with its **own tabs** (add/select/close
  per side), so nothing you type is echoed into the other pane. Persists per session across
  switches.
- **Resume after restart** — Studio restarts and re-attaches every active session; the
  Claude conversation resumes with full history.
- **Rename** a session; **Deactivate** (stop but keep) / **Resume** (relaunch) it.

### Promote & worktrees
- One-click promote with automatic branch/name suggestion and collision auto-suffixing.
- Local-config copy on create (`copyPatterns`), so FE worktrees build immediately.
- **Adopt** an existing worktree as a session (start Claude in a worktree that already exists).
- Manual worktree create/delete via the API/Fleet.

### Dev servers
- **Auto-discovery** of running servers by matching listening ports to worktree paths
  (`lsof` → cwd), cached and refreshed on a timer (not on every event).
- Start / stop / restart per session or per feature (stack).
- **Per-worktree log files**, tailed live in the **▸ Logs** tab.
- **Open ‹frontend› ↗** buttons wherever a web repo is running (session bar **and** the
  Fleet “Servers running” section).

### Changes / commits / diff
- Aggregated across all repos of a feature, grouped by repo.
- The branch’s commits (base..HEAD, base = the closest merge-base with the default
  branch), newest first, plus each repo’s uncommitted working-tree changes pinned on top.
- Click a commit → all its file diffs; click a file → just that file. Commit an uncommitted
  entry (with amend), Commit & PR.

### PR / CI
- **PR/CI pill** per promoted session: `gh` / `glab` reports passed/running/failed and
  links to the PR/MR. **Pushed, not polled** — it arrives on the `ci` SSE event, which
  the server refreshes when a commit, a push or a branch switch lands, when a PR is
  opened, and on a slow safety net, and *only* while a browser stream is open: with no
  dashboard attached, neither CLI is ever spawned. Briefly cached and shared with
  `GET /api/sessions/:id/ci`, the on-demand answer SwiftBar/Alfred still use. Degrades
  gracefully when no PR exists or the CLI is missing.
- **Open PR / MR** and **Create PR** (`/api/group/pr`) across the feature’s repos.

### Notifications
- Desktop **Notification** + optional sound when a session flips to **waiting** (and
  optionally **idle**). Tab-title prefix + a Fleet badge show the waiting count.
- Preferences in Settings (`notify.waiting`, `notify.sound`, `notify.idle`).

### Command palette & keyboard
- **⌘K** fuzzy palette: jump to any session, or run New / Promote / Review / Run / toggle
  view / Settings / shortcuts.
- Full keyboard nav (see [shortcuts](#keyboard-shortcuts)).

### Settings (in-app)
- Edit dev-server commands (`start.<repo>`), editors, groups, and notification prefs;
  persisted via `/api/settings`.

---

## Views: Work vs Fleet

Toggle with the header segmented control or **⌘\\**.

**Work** — the session cockpit. A left rail of sessions grouped by feature; the selected
session’s terminal, tabs, server bar, and the Changes/Logs dock.

**Fleet** — the mission-control overview, in three sections (top to bottom):
1. **⇅ Servers running** — every feature with a live dev server: its ports, **Open ‹fe› ↗**,
   Go to session, Stop stack. This is where you watch running work.
2. **✦ Agents · no worktree** — unpromoted sessions. Promote, go to, resume, or delete.
3. **⎇ Worktrees** — every feature (grouped, manual + auto). Per feature: agent/servers
   status pills, concurrency slot badge, Go to session / Start session, Run/Stop stack,
   Open ‹fe›, and a **⋯** menu (Open in editor, Restart stack, Open PR/MR, Close/Delete).

Fleet also has a summary bar (feature/running/working/waiting counts) with **Stop all** /
**Restart all**.

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `⌘K` | Command palette (works even while typing) |
| `⌘N` | New session |
| `⌘\` | Toggle Work / Fleet |
| `⌘1`–`⌘9` | Jump to the Nth session in the rail |
| `⌘↵` | Promote current session to a worktree |
| `⌘D` | Review changes (open the ✎ Changes tab) |
| `⌘R` | Run the current feature’s dev servers |
| `?` | Keyboard-shortcuts cheatsheet |
| `Esc` | Close the topmost overlay (palette → settings → intake) |

Shortcuts never fire while you’re typing in the terminal/inputs or when an overlay is up
(except `⌘K` and `Esc`). On non-Mac, `Ctrl` substitutes for `⌘`.

---

## Running features concurrently (slots)

Studio can run **2–3 features at once** even though the repos normally hardcode shared
ports and a shared dev database. Each feature gets a **slot** (0, 1, 2…); its ports and
Redis DB are offset by `slot × offsetStep` (default 100).

- **accept-blue (backend)** reads its ports from environment variables Studio injects, so
  **no backend code change is needed**. Slot 0 uses the normal ports; slot 1 adds +100, etc.
  Env keys: `api__port_su` (1231), `api__port_iso` (1232), `api__port` (1233),
  `api__port_merchant` (1239), `api__port_internal` (1999); Redis via `redis__db`.
  (The `__` is nconf’s nested-key separator.)
- **Frontends** (`merchant-v3` vite :3030, `ab-iso-fe` webpack :9000, `ab-su` vite :8000)
  are wired per slot by patching the gitignored local config in the worktree
  (`src/config.js` or `src/config/config.js`) to point at that slot’s backend.

Slots are persisted in `servers.json` and self-heal against reality on restart, so a
frontend never silently points at the wrong backend after a restart. The **shared dev
database** is intentionally still shared across slots.

> The **job scheduler** must only ever run in one stack. Only the primary/`job_schedule`
> stack runs jobs; never start more than one job-running instance.

---

## Configuration reference

Config lives at `~/.config/worktree-studio/config.json`. Missing keys fall back to
built-in defaults (and `copyPatterns.default` / `copyAlways.default` are **unioned** with
the defaults on every load, so you always get the full set even if your file lists an
older subset).

The four blocks with real choices in them — worktree layout, feature identity, copy
patterns and concurrency — have a reference of their own with worked examples:
**[docs/config.md](docs/config.md)**. Every default below reproduces the behavior Studio
had before those conventions were configurable.

| Key | Default | Purpose |
|-----|---------|---------|
| `baseDirs` | `['~/Desktop/ab-code']` | Roots scanned for git repos |
| `scanDepth` | `3` | How deep to scan for repos |
| `web.port` / `web.host` | `7788` / `127.0.0.1` | Server bind (also the `Host`/`Origin` allowlist) |
| `claude.cmd` | `claude` | The agent binary (swappable) |
| `editors` | WebStorm, Zed | `{ name: { open: 'cmd {path}' } }` |
| `defaultEditor` | `WebStorm` | Editor used by “Open in editor” |
| `worktrees.layout` | `nested` | `nested` (`<repo>/<dir>/<name>`), `sibling` (`<repo>/../<name>`) or `external` (`<root>/<repo>/<name>`) |
| `worktrees.dir` | `.worktrees` | `nested` only — the container dir inside the repo (must be gitignored) |
| `worktrees.root` | `''` | `external` only — root of the worktree tree; required for that layout |
| `featureIdentity.strategy` | `basename` | What makes two worktrees one feature: `basename`, `branch` or `manifest` |
| `featureIdentity.branchPattern` | `''` | `branch` only — regex with one capture group, matched against the branch name |
| `featureIdentity.branchFlags` | `''` | `branch` only — regex flags (`g`/`y` ignored) |
| `copyPatterns.default` | `.env`, `.env.local`, `.env.*.local`, `.env*`, `config/*-config.js`, `src/config.js`, `src/config/config.js`, `.vscode/*.json` | **Gitignored** files copied into new worktrees |
| `copyPatterns.<repo>` | — | Per-repo override list |
| `copyAlways.default` | `.idea/runConfigurations/*.xml` | Copied into new worktrees **whether or not git ignores them** — editor scratch. `[]` turns it off |
| `copyAlways.<repo>` | — | Per-repo override list |
| `start.<repo>` | `{}` | Dev-server launch: `{ cmd, ports:[…] }` |
| `webRepos` | `merchant-v3`, `ab-iso-fe`, `ab-su` | Repos that get an “Open ‹repo› ↗” button |
| `groups` | `[]` | Manual feature groups `{name, members:["repo/branch"]}` |
| `runConfigs` | `{}` | Editor run-config import mapping |
| `popout.terminal` | `Terminal` | macOS app used for Pop-out |
| `sources.github.enabled` | `true` | GitHub intake |
| `sources.gitlab` | `{enabled:false, host, token}` | GitLab intake |
| `sources.asana` | `{enabled:false, token, workspace}` | Asana intake |
| `notify` | `{waiting:true, sound:true, idle:false}` | Attention prefs |
| `concurrency.enabled` | `true` | Master switch for slots |
| `concurrency.offsetStep` | `100` | Port/DB offset per slot |
| `concurrency.maxSlots` | `3` | Max simultaneous features |
| `concurrency.repos.<repo>` | see below | Per-repo slot wiring |

**Per-repo concurrency wiring** (`concurrency.repos.<repo>`):
- `portEnv` — env vars → base ports (offset by slot). Backend: `api__port_*`, `redis__db`.
  Frontends use `WTS_FE_PORT`.
- `slotEnv` — extra keys offset by slot index (e.g. `redis__db`).
- `configPatch` — `{ file, siblingRepo }`: the gitignored config file in a FE worktree to
  rewrite so it targets its slot’s backend.

Everything is also overridable by environment variables using nconf’s `__` nesting (e.g.
`web__port=7799`), which is how the isolated test harness runs a second instance.

---

## Command-line interface

Installed as `wt-studio` (`bin/wt-studio.ts`):

```bash
wt-studio                    # start the server (same as npm start)
wt-studio add-repo <repo>    # add a repo to the CURRENT session's feature
```

`add-repo` reads `WT_STUDIO_SESSION` from the environment (Studio injects it into every
session), so **Claude itself** can run it to pull a second repo into the feature. It POSTs
to the running server and creates + `/add-dir`s the new worktree.

---

## HTTP & WebSocket API

Base URL `http://127.0.0.1:7788`. All JSON.

Every request is authenticated. Send `x-wts-token: $(cat
~/.local/state/worktree-studio/token)` — or `?token=…` for `EventSource` and the
WebSocket, which can't set headers. The server also refuses any request whose
`Host` isn't a loopback name (DNS-rebinding defense) or whose `Origin`, if it has
one, isn't this server. `docs/api.md` has the full rules; the SwiftBar, Alfred and
`wt-studio` clients already do all of this.

**State & events**
- `GET /api/state` — full snapshot (repos, worktrees, sessions, features, servers, webRepos).
- `GET /api/events` — Server-Sent Events stream (live updates). Three named events:
  `topology` (repos/worktrees/features, sent when the shape changes),
  `session-state` (`{sessions, servers}`, sent on every Claude hook) and
  `ci` (`{ci}` — each session's PR/MR + checks, sent only when that snapshot
  actually differs, on the order of minutes). One of each on connect = a full
  snapshot. Each is a full replacement of its half, never a delta. See `docs/api.md`.
- `GET /api/settings` · `POST /api/settings` — read/write config.
- `GET /api/sources` · `GET /api/sources/:source/items` — intake sources & their items.

**Sessions**
- `POST /api/sessions` — create.
- `DELETE /api/sessions/:id` — delete (stops servers, frees slot; `?kill=false` to keep tmux).
- `POST /api/sessions/:id/promote` — promote to a worktree (`{branch, name, confirm}`).
- `POST /api/sessions/:id/activate` · `/deactivate` — resume / stop.
- `POST /api/sessions/:id/rename` · `/popout` · `/add-repo`.
- `POST /api/sessions/:id/tabs` · `/select-tab` · `/close-tab` — primary-terminal tabs.
- `GET/POST /api/sessions/:id/split/tabs` · `/split/select-tab` · `/split/close-tab` — split-pane tabs.
- `POST /api/sessions/:id/servers/start` · `/servers/stop`.
- `GET  /api/sessions/:id/commits` · `/commit-detail?repo=&sha=` · `POST /commit` — review/commit.
- `GET  /api/sessions/:id/ci` — PR/CI status.

**Features / groups**
- `POST /api/group/session` — start a session for a feature.
- `POST /api/group/start` · `/stop` · `/restart` — the dev-server stack.
- `POST /api/group/open` — open in editor.
- `POST /api/group/pr` — create PRs/MRs across the feature.
- `POST /api/group/close` · `/delete` — close (keep) / delete (remove) the feature.

**Worktrees & servers**
- `POST /api/worktrees` · `DELETE /api/worktrees` · `POST /api/worktrees/adopt`.
- `POST /api/servers/start` · `/stop` · `/restart`; `GET /api/servers/logs?offset=`.
- `POST /api/open` — open an arbitrary path in the editor (shell-quoted).

**Other**
- `POST /hook/:event` — inbound Claude Code hook receiver (status updates).
- `WS /ws/term?session=<id>&pane=<primary|split>&cols=&rows=` — terminal I/O.

---

## Files & state on disk

**Config** — `~/.config/worktree-studio/`
- `config.json` — your settings.
- `tmux.conf` — Studio’s tmux config for its sessions.

**State** — `~/.local/state/worktree-studio/`
- `sessions.json` — the session registry (id, home, worktree, branch, claudeSessionId…).
- `servers.json` — `{ tracked: {…running servers}, slots: {…concurrency} }`.
- `hooks/<id>.settings.json` — the per-session Claude `--settings` file (auto-removed on
  session close).
- `logs/<repo>__<feature>.log` — per-worktree dev-server logs.
- `locks/` — per-worktree operation locks.
- `server.log` — Studio’s own log.

**Worktrees** — `<repo>/.worktrees/<name>` (gitignored), created by Studio.

**Claude transcripts** — `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, owned by
Claude Code. `/cd` on promote moves the transcript into the worktree’s project dir.

---

## Claude Code integration

Studio drives a **real** Claude Code CLI, not an imitation. The coupling is deliberately
shallow — the worktree/terminal/server engine is agent-agnostic — but these pieces are
Claude-specific:

- **Live status** comes from Claude Code **hooks**. Studio writes a per-session
  `--settings` file whose `PreToolUse`/`PostToolUse`/`SessionStart`/`SessionEnd` hooks POST
  to `/hook/:event`. `SessionStart` captures the `claudeSessionId` used for resume;
  `SessionEnd` marks the session inactive. Your global Claude settings are untouched.
- **Seeding** — the intake prompt is passed to Claude as its opening message (a launch
  argument, not typed), so it lands reliably.
- **Resume** — `claude --resume <id>` relaunches with full history. A conversation’s
  transcript is anchored to its **launch directory**; `--resume` only finds it from that
  directory or its git worktrees.
- **Promote → `/cd`** — because of that anchoring, promote sends the real `/cd <worktree>`
  slash command, which relocates both cwd **and** transcript into the worktree (Claude Code
  v2.1.169+). Studio then records the worktree as the session’s home, so resume is seamless.
  A self-heal re-issues `/cd` on resume if it ever didn’t land at promote time.
- **`--add-dir`** — used by `add-repo` to grant a session access to a second repo’s worktree.
- **`WT_STUDIO_SESSION`** — injected into every session so the `wt-studio` CLI (and Claude)
  can act on the current session.
- **Swappable** — `claude.cmd` points at the binary; another agent CLI could be wired in by
  providing its own status/resume mechanism.

---

## Troubleshooting

**A frontend worktree won’t build — `Can't resolve '../config/config'`.**
Its gitignored local config wasn’t copied in. Worktrees Studio creates get it automatically
(`copyPatterns`), but a worktree made another way (e.g. an old `wt` run) won’t. Copy your
main checkout’s `src/config/config.js` (iso-fe/su) or `src/config.js` (merchant-v3) into the
worktree.

**Resume shows `No conversation found with session ID`.**
The session was resumed from a directory other than where its transcript lives. Fixed by the
`/cd`-on-promote flow (home tracks the worktree). If you see it on an older session, resume
it once from Fleet — the self-heal re-anchors it.

**“Open ‹frontend›” button missing in Fleet.**
The button needs a **detected port**. If the running frontend shows its `:port` chip but had
no button, that’s fixed (the Servers-running section now renders it). If it shows **no port
chip**, the dev server’s port isn’t being discovered — check `start.<repo>.ports`.

**Ghost commands typed into the terminal.**
Studio waits for Claude to be ready before injecting anything and sends slash commands
literally; this was a past bug and is resolved.

**Port already in use on restart.**
Kill the old server first: `lsof -ti :7788 | xargs kill`, then `npm start`. (macOS has no
`setsid`; run detached with `nohup … &`.)

---

## Architecture

- **Backend** — Node + Express + `ws` + `node-pty`. Key modules:
  `server/server.ts` (HTTP/WS/routes), `server/sessions.ts` (session lifecycle, promote,
  resume), `server/servers.ts` (dev-server discovery/start/stop, slots), `server/review.ts`
  (diff/commit), `server/features.ts` (grouping), `server/config.ts` (config + defaults),
  `server/concurrency.ts` (slot math + config patching), `server/multiplexer/tmux.ts`
  (the tmux driver behind a small interface — the seam for a future ConPTY/Windows driver).
- **Frontend** — SvelteKit (`client/`), built by `adapter-static` to `client/build` and
  served by the daemon itself (`server/webui.ts`); `npm install` builds it, `npm start`
  does not. State arrives via SSE; terminals over WebSocket. The previous vanilla-JS UI
  (`public/app.js` + vendored xterm, no build step) is still in the tree — start with
  `WTS_UI=legacy` to serve it instead. Only one of the two owns `/`.
- **Multiplexer** — tmux only, socket `-L wt-studio`, sessions `wts-<name>-<id>`; grouped
  sessions (`-popout`, `-split`) give independent panes.
- **Tests** — `node --test test/*.test.js`.

---

*Generated from the codebase. Keep this in sync when adding routes, config keys, shortcuts,
or lifecycle behavior.*
