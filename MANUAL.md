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
2. [Install & run](#install--run) — including [start at login](#start-it-at-login-macos)
3. [Menubar and Alfred](#menubar-and-alfred)
4. [The feature lifecycle](#the-feature-lifecycle) — the spine of the tool
5. [Feature reference](#feature-reference)
6. [The layout](#the-layout)
7. [Keyboard shortcuts](#keyboard-shortcuts)
8. [Running features concurrently (slots)](#running-features-concurrently-slots)
9. [Configuration reference](#configuration-reference)
10. [Command-line interface](#command-line-interface)
11. [HTTP & WebSocket API](#http--websocket-api)
12. [Files & state on disk](#files--state-on-disk)
13. [Claude Code integration](#claude-code-integration)
14. [Troubleshooting](#troubleshooting)
15. [Architecture](#architecture)

---

## Concepts & glossary

| Term | Meaning |
|------|---------|
| **Session** | A live Claude Code process running inside a tmux session, tracked by Studio with an id like `s_5ii11`. This is where you actually talk to Claude. **The UI says “session” everywhere** — it used to say “agent” in some places and “session” in others for this one thing. Where the docs say *agent*, they mean the process itself (`claude.cmd`, “agent-agnostic”), not the Studio object. |
| **Repo** | One of your git repositories under `baseDirs` (e.g. `api`, `web`, `admin`, `portal`). Discovered automatically. |
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
npm install          # runs postinstall: fixes node-pty perms + builds the client
npm start            # → http://127.0.0.1:7788
```

Or via the CLI (same thing): `wt-studio`. Run tests with `npm test`.

On first run Studio writes a default config to `~/.config/worktree-studio/config.json`
and scans `baseDirs` (default `~/code`) for git repos.

### Start it at login (macOS)

```bash
./install.sh --autostart
```

That installs a launchd **agent** — `~/Library/LaunchAgents/com.worktree-studio.plist`
— which starts the server at every login and restarts it if it dies (`RunAtLoad` +
`KeepAlive`). It runs as you, in your GUI session, which is what tmux, your git
credentials and your editor all assume.

| | |
| --- | --- |
| Log | `~/.local/state/worktree-studio/studio.log` |
| Restart | `launchctl kickstart -k gui/$UID/com.worktree-studio` |
| Stop for now | `launchctl bootout gui/$UID/com.worktree-studio` |
| Remove | `./uninstall.sh` |

Two things the generated plist has to spell out, because launchd will not work them
out for you:

- **PATH.** launchd hands a process `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else.
  Studio still starts when it cannot find `tmux`, and says so in the log and in a banner
  across the top of the UI — sessions and terminals will not work until it is installed.
  It does not exit, so an autostarted daemon does not crash-loop where nobody can read
  the reason. `git`/`gh`/`glab` would
  fail the same way, so the agent carries an explicit PATH with Homebrew on it.
- **The node binary, absolutely.** An nvm-managed node is on no PATH launchd would
  build, so the plist names the exact binary. **Re-run `./install.sh --autostart`
  after changing node versions**, or the agent keeps launching a node that may no
  longer exist.

The generated file is derived from `launchd/com.worktree-studio.plist.template`, and
it points at whatever checkout you ran `install.sh` from — re-run it from the new
place if you move the repo.

---

## Menubar and Alfred

Both surfaces are thin clients over the same [HTTP API](docs/api.md): they read
`GET /state` and POST the same routes the web UI does. Both find the port in your
config and the token in `~/.local/state/worktree-studio/token`, so neither needs
configuration of its own. Both need `jq`.

### SwiftBar (menubar)

`install.sh` symlinks `swiftbar/worktrees.10s.sh` into SwiftBar's plugin folder. The
title carries one number, picked by urgency — agents **waiting on you** (🟡), else
agents working (⚙), else dev servers up (▶). Open it for:

- **Sessions**, waiting first, each with its activity, the repos it spans, and a link
  to its ticket when it came from one. Clicking one opens the cockpit *on that
  session* — see [Deep links](#deep-links).
- **Features**, each with its members' branches, ports, merge marks and concurrency
  slot, plus start / stop / restart / open-in-editor for the whole stack.

Failures surface as a macOS notification, because a menubar click has no console.

**The daemon's own health** is the last item, and it answers a question the API
cannot: the API answering means the daemon is up, but not *how* it is up or what is
wrong when it isn't. The plugin asks launchd directly and reports one of:

| | |
| --- | --- |
| 🟢 running at login · pid N | healthy, under the agent. Restart or stop it from here. |
| 🟡 started by hand | works, but dies with its terminal — offers to install the agent |
| 🟡 answering, but the agent is not running | a second copy is serving the port |
| 🟠 starting, or wedged | launchd has a live pid, the API is silent. Never offers a Start — launchd already did. |
| 🔴 keeps crashing | agent present, nonzero last exit, climbing launch count. Sends you to the log, because a restart would only repeat it. |

The distinction matters because of `KeepAlive`: a crashing daemon is relaunched
within seconds, so "not running" with a Start button would be both fleeting and
useless — it would ask you to press what launchd is already pressing.

### Alfred

Double-click **`alfred/Worktree Studio.alfredworkflow`** to import it. The keyword is
`wt`. (Editing `alfred/src/*.sh` does nothing until you re-run `alfred/build.sh` and
re-import — Alfred copies a workflow into its own preferences on import, so the
bundle is a snapshot.)

Type `wt` to get your active sessions first, then every worktree, and:

| Key | On a session | On a worktree |
| --- | --- | --- |
| `⏎` | **open it in Studio** — the cockpit, focused on that session | open it in Studio: its agent, or its feature |
| `⌘` | open its worktree in your editor | open it in your editor |
| `⌃` | start the whole feature's stack | start this repo's dev server |
| `⌥` | open its ticket ↗, or stop the stack when there is no ticket | stop this repo's dev server |
| `⇧` | reveal in Finder | reveal in Finder |

A modifier whose action cannot apply — no worktree yet, no `start` command
configured, nothing running to stop — is shown greyed out with the reason, rather
than accepting the keystroke and doing nothing.

### Deep links

`⏎` works because the cockpit reads its selection from the URL fragment:

| Link | Opens |
| --- | --- |
| `http://127.0.0.1:7788/#s:<session-id>` | that session |
| `http://127.0.0.1:7788/#f:<feature-name>` | that feature |
| `http://127.0.0.1:7788/#w:<main-checkout-path>` | that main-checkout dev server |

It is the rail's own key scheme, not a second vocabulary for the same three things,
and the value is percent-encoded so group names with spaces and paths with `#` in
them survive. The menubar's session and feature lines use the same links.

This works in **both** directions and in an **already-open tab**, which is what makes
it usable rather than a demo:

- Following a link when a tab is already on the cockpit changes only the fragment —
  no reload, no mount — so the app listens for `hashchange` rather than reading the
  URL once at startup. Without that, the second link you followed would appear to do
  nothing.
- Navigating inside Studio rewrites the fragment, so the address bar is always a link
  to what you are looking at. It uses `replaceState`: assigning `location.hash` would
  push a history entry per click and turn Back into an undo of your last twenty
  selections.

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
When the work is real, click **⤴ Promote**. Studio:
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
wt-studio add-repo web
```

Studio creates a same-named worktree in that repo and grants the session access via
`/add-dir`. All repos of a feature share the worktree **name**, which is how they group.

### 4. Run the dev servers
**Run stack** in the action bar starts the configured dev servers for every repo of the
feature; **Stop stack** and **Restart stack** replace it once they are up. Running
frontends get an **Open ‹repo› ↗** button beside it. The server bar above shows the ports
they bound but has no buttons of its own — one verb, one place.

If a repo cannot start, the result says so by name rather than reporting the rest as a
success: `Skipped ab-libraries — no start command configured`, or `dependencies not
installed`, which the **Install deps** button next to it fixes.

### 4b. Run tests and other configurations
**▷ Run** in the action bar lists the run configurations your editor already has, read
live from each worktree of the feature — no import step, and nothing to keep in sync.

Studio reads, per worktree:
- `.idea/runConfigurations/*.xml` (JetBrains) — npm scripts, mocha runs, Node files
- `.vscode/tasks.json` and `.vscode/launch.json` — npm/shell tasks, and launches that
  name a runnable command (a debugger-only entry is skipped, not approximated)
- `.zed/tasks.json`

They are grouped by repo, since a feature spans several and two repos often both have a
`test:unit`. Two kinds, and the glyph says which:

| | | Where it runs |
|---|---|---|
| ▸ | **server** | Tracked exactly like a dev server — a pid, a log in **Logs**, and **Stop stack** reaches it |
| ⌗ | **task** | A **run**: status, duration, exit code and output, in the **▶ Runs** panel |

#### The Runs panel
A task is a job, not a conversation, so it does not get a terminal pane. **▶ Runs** lists
every run for the feature's worktrees, newest first, with a status dot (running / passed /
failed / stopped), how long it took, and the exit code when it failed. Pick one to read its
output; the tab badge counts what is running right now.

- **↻** runs it again. It repeats the *recorded* command, not whatever the configuration
  says today — so a history row keeps working after the config is renamed or deleted, and
  cannot quietly run something different because the file changed. Use **▷ Run** for the
  current version; that menu re-reads the files every time it opens.
- **Stop** kills the whole process group, so a test runner's children go with it.
- **✕** forgets a finished run and deletes its log. A running one refuses until stopped.
- The last 60 runs are kept, and they survive a daemon restart — one that was still running
  when the daemon died is marked *stopped* rather than left claiming to be in progress.
- Output is pulled as a byte-offset tail while the run is going, and stops polling the
  moment it ends: a finished log cannot change.

A config is a *server* if its script looks like one (`start`, `dev`, `serve`, `watch`), if
VS Code marks it `isBackground`, or — most reliably — if its command matches the repo's
own `start.<repo>.cmd`. Everything else is a task, which is the safe default: a long-lived
process in a tab is inconvenient, but a finished one tracked as a server looks like a crash.

An unrecognised configuration type is **skipped, never guessed at** — these produce
commands that get executed.

`config.runConfigs[<repo>]` still works and is merged in, for anything no editor config
expresses. Discovered entries win a name clash, since the file on disk is the live truth.

Because `copyAlways` copies `.idea/runConfigurations/*.xml` into every new worktree, your
JetBrains configs are there from the moment a worktree exists — and `$PROJECT_DIR$`
resolves to *that* worktree, not the checkout it came from.

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
From the action bar, with the feature selected:
- **Close feature** — stops servers, deactivates the session, **keeps** the worktree/branch.
- **Delete feature** — stops servers, kills the session, **removes** the worktree(s)
  (optionally the branch too).

Deleting a session (🗑) also stops its servers and frees its concurrency slot.

---

## Feature reference

### Sessions & terminals
- **Live embedded terminal** (xterm.js) with two-way I/O to the tmux session.
- **Tabs** per session (`claude`, `shell`, …) — add, select, close tabs.
- **Resume after restart** — Studio restarts and re-attaches every active session; the
  Claude conversation resumes with full history.
- **Rename** a session; **Deactivate** (stop but keep) / **Resume** (relaunch) it.

### Promote & worktrees
- One-click promote with automatic branch/name suggestion and collision auto-suffixing.
- Local-config copy on create (`copyPatterns`), so FE worktrees build immediately.
- **Adopt** an existing worktree as a session (start Claude in a worktree that already exists).
- Manual worktree create/delete via the API.

### Dev servers
- **Auto-discovery** of running servers by matching listening ports to worktree paths
  (`lsof` → cwd), cached and refreshed on a timer (not on every event).
- Start / stop / restart the whole feature (stack) from the action bar.
- **Per-worktree log files**, tailed live in the **▸ Logs** tab.
- **Open ‹frontend› ↗** in the action bar wherever a web repo is running.

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
  optionally **idle**). Tab-title prefix + a top-bar badge show the waiting count.
- Preferences in Settings (`notify.waiting`, `notify.sound`, `notify.idle`).

### Command palette & keyboard
- **⌘K** fuzzy palette: jump to any session, or run New / Promote / Review / Run / toggle
  view / Settings / shortcuts.
- Full keyboard nav (see [shortcuts](#keyboard-shortcuts)).

### Settings (in-app)
- Edit dev-server commands (`start.<repo>`), editors, groups, and notification prefs;
  persisted via `/api/settings`.

---

## The layout

One screen, four regions. There is no view to switch between — Work and Fleet were
merged, because Fleet was the same three lists the rail already drew.

**The rail** (left) — one flat list, one row per thing: features, unpromoted sessions,
and dev servers running from a repo's main checkout. Active first (a live session or a
running server), then alphabetical, with an `idle · N` divider marking where the quiet
ones start. Filter by repo at the top. Cards are readouts; they carry no buttons.

**The dock** (right) — the selected session's identity header, its terminal tabs, the
Changes and Logs panels, and the server bar.

**The server bar** (under the dock) — a READOUT: every repo the session owns, its ports,
and the PR/CI pills. No buttons.

**The action bar** (bottom) — every verb for whatever is selected. The rule: the top says
what you are looking at, the bottom does something to it.

**Insights** (**⌘\\** or ◔ in the top bar) — one destination: a fleet-wide cost overview
you drill into. Picking a session shows its token breakdown and transcript search.

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `⌘K` | Command palette (works even while typing) |
| `⌘N` | New session |
| `⌘\` | Insights (fleet cost overview) |
| `⌥1`–`⌥9` | Jump to the Nth row in the rail |
| `⌘⇧F` | Search every transcript |
| `⌘D` | Review changes (open the ✎ Changes tab) |
| `⌘R` | Run the current feature’s dev servers |
| `F2` | Rename the current terminal tab |
| `?` | Keyboard-shortcuts cheatsheet |
| `Esc` | Close the topmost overlay — or, with nothing open, interrupt the agent |
| `⌘↵` / `⇧↵` | Terminal: newline without submitting |
| `⌘←` / `⌘→` | Terminal: start / end of line |

Shortcuts never fire while you’re typing in the terminal/inputs or when an overlay is up
(except `⌘K` and `Esc`). On non-Mac, `Ctrl` substitutes for `⌘`.

---

## Running features concurrently (slots)

Studio can run **2–3 features at once** even though the repos normally hardcode shared
ports and a shared dev database. Each feature gets a **slot** (0, 1, 2…); its ports and
Redis DB are offset by `slot × offsetStep` (default 100).

- **api (backend)** reads its ports from environment variables Studio injects, so
  **no backend code change is needed**. Slot 0 uses the normal ports; slot 1 adds +100, etc.
  Env keys: `api__port_portal` (1231), `api__port_admin` (1232), `api__port` (1233),
  `api__port_web` (1239), `api__port_internal` (1999); Redis via `redis__db`.
  (The `__` is nconf’s nested-key separator.)
- **Frontends** (`web` vite :3030, `admin` webpack :9000, `portal` vite :8000)
  are wired per slot by patching the gitignored local config in the worktree
  (`src/config.js` or `src/config/config.js`) to point at that slot’s backend. That half
  works with no repo change.
  
  Their OWN listening port shifts by one of two routes. If the repo's dev server reads
  `WTS_FE_PORT`, the slot's env carries it. If it does not — vite, next and ng all bind
  whatever is in their own config and take `--port` instead — set `portFlag` for that
  repo (e.g. `"portFlag": "-- --port {port}"` for an npm script) and Studio appends the
  slot's first port to the start command. See `docs/config.md` for the field. Without
  either, a second feature's frontend binds the repo's hardcoded default and collides;
  Studio detects and names that rather than failing silently — see the troubleshooting
  entry.

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
| `baseDirs` | `['~/code']` | Roots scanned for git repos |
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
| `webRepos` | `[]` | Repos that serve a browser — each gets an “Open ‹repo› ↗” button |
| `groups` | `[]` | Manual feature groups `{name, members:["repo/branch"]}` |
| `runConfigs` | `{}` | Editor run-config import mapping |
| `watch` | see `server/watch.ts` | fs-watch pacing; fully typed as `WatchPacing`, hand-edit only |
| `sources.github.enabled` | `true` | GitHub intake |
| `sources.gitlab` | `{enabled:false, host, token}` | GitLab intake |
| `sources.asana` | `{enabled:false, token, workspace}` | Asana intake |
| `notify` | `{waiting:true, sound:true, idle:false}` | Attention prefs |
| `concurrency.enabled` | `true` | Master switch for slots |
| `concurrency.offsetStep` | `100` | Port/DB offset per slot |
| `concurrency.maxSlots` | `3` | Max simultaneous features |
| `concurrency.repos.<repo>` | see below | Per-repo slot wiring |
| `featureColors` | `{}` | Feature name → colour tag, set from the rail |
| `featureLinks` | `{}` | Feature name → pinned links (ticket, MR, dashboard) |
| `linkProviders` | `[]` | Patterns that turn a branch or ticket id into a link |

**Per-repo concurrency wiring** (`concurrency.repos.<repo>`):
- `portEnv` — env vars → base ports (offset by slot). Backend: `api__port_*`, `redis__db`.
  Frontends: `WTS_FE_PORT`.

  **The repo has to actually read the variable.** Studio sets it in the launch
  environment; it cannot make a dev server listen anywhere. `api` works because
  its config calls `nconf.env({separator: '__'})`, which maps `api__port_portal` to
  `api.port_su`. A frontend whose vite/webpack config ignores `WTS_FE_PORT` binds its
  hardcoded port on every slot — so a second feature's frontend hits `EADDRINUSE`, and a
  stack start reports `started on port N instead of the port this feature's slot expects`.
- `slotEnv` — extra keys offset by slot index (e.g. `redis__db`).
- `configPatch` — `{ file, siblingRepo }`: the gitignored config file in a FE worktree to
  rewrite so it targets its slot’s backend.

**There are no `web__port`-style env overrides.** This document used to claim config was
overridable by environment variables using nconf's `__` nesting — that is the accept.blue
backend's config system, not Studio's. Studio has no nconf dependency and reads exactly
three environment variables, all of them paths:

| Variable | Overrides |
|----------|-----------|
| `WT_STUDIO_CONFIG_DIR` | the directory holding `config.json` |
| `WT_STUDIO_CONFIG` | the config file itself |
| `WT_STUDIO_STATE` | the state directory (`~/.local/state/worktree-studio`) |

Everything else is the JSON file.

### Config is read once, at boot

`load()` runs at startup and the result is held in memory for the life of the process.
**A hand-edit to `config.json` does nothing until you restart the daemon.** The Settings
UI is the exception: it mutates the in-memory config as well as the file, so those changes
take effect immediately.

Settings can edit: `baseDirs`, `start.<repo>`, `editors` (name + `open`), `groups`,
`sources`, `notify`. Everything else — including `worktrees`, `featureIdentity`,
`concurrency`, `copyPatterns`, `copyAlways`, `webRepos`, `web.port` and `scanDepth` — is
hand-edit-only, and needs the restart.

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
- `POST /api/sessions/:id/rename` · `/add-repo`.
- `POST /api/sessions/:id/tabs` · `/select-tab` · `/close-tab` — primary-terminal tabs.
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
- `WS /ws/term?session=<id>&cols=&rows=` — terminal I/O.

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
- `token` — the API token (mode `0600`); every client reads it from here.
- `studio.log` — the server's own stdout/stderr, when it runs under the launchd agent.

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
main checkout’s `src/config/config.js` (iso-fe/su) or `src/config.js` (web) into the
worktree.

**Resume shows `No conversation found with session ID`.**
The session was resumed from a directory other than where its transcript lives. Fixed by the
`/cd`-on-promote flow (home tracks the worktree). If you see it on an older session, resume
it once — the self-heal re-anchors it.

**“Open ‹frontend›” button missing.**
The button needs a **detected port**. If the row shows **no port chip**, the dev server's
port isn't being discovered — check `start.<repo>.ports`.

**A stack start reports “started on port N instead of the port this feature's slot
expects”.**
The server is up, on the wrong port. Studio derives a per-slot port from
`concurrency.repos.<repo>.portEnv` and passes it as an env var; that repo does not read
it, so it bound its hardcoded port. Until the repo reads the variable, only one feature at
a time can run it.

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
  does not. State arrives via SSE; terminals over WebSocket.
- **Multiplexer** — tmux only, socket `-L wt-studio`, sessions `wts-<name>-<id>`. The
  pop-out and split-pane sessions (`-popout`, `-split`) were removed; `kill()` still
  tears them down so a session created before the removal cannot outlive its owner.
- **Tests** — `npm run verify` runs what CI runs (lint · format · typecheck · tests);
  `npm run test:server` alone is `node --test 'test/**/*.test.ts'`.

---

*Generated from the codebase. Keep this in sync when adding routes, config keys, shortcuts,
or lifecycle behavior.*
