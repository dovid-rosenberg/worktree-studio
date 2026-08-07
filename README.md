# Worktree Studio

**One place to start, watch, and steer Claude Code sessions — from any source, into a worktree, without leaving the loop.**

The origin of work is a *real Claude Code session* (booted on your `CLAUDE.md`), not a form.
Start one from free text, a GitHub / GitLab issue, or an Asana task; it runs in an
embedded terminal backed by a persistent tmux session. When it's clearly real work,
**promote** it — one click creates a worktree (run configs + local files carried in)
and the *same session continues into it*. Status is pushed by Claude Code hooks;
sessions survive a shutdown and resume where they left off.

## One surface

One engine (this server) and one screen — there is no view to toggle:

- a **rail** of everything you are working on, one row per thing, active first;
- a **dock** showing the selected session's terminal, its changes, its logs, or —
  with nothing selected — fleet-wide **Insights**;
- an **action bar** along the bottom holding every action for whatever is selected.

Worktrees sharing a name across repos group into a **feature** (BE+FE by shared name,
plus manual groups), which is what start / stop / restart / stop&switch act on. The
SwiftBar menubar and Alfred read the same `/api/state` (no more `core.sh`).

## What it does

- **Pluggable intake.** Free text · GitHub (`gh`) · GitLab (`glab`/token) · Asana (token).
  Every source resolves to one seed shape and seeds the session's first message.
- **Features.** Worktrees/sessions sharing a name across repos auto-group; manual groups via
  `config.groups`. Running dev servers are **discovered by lsof→cwd** (any server in any worktree,
  not just configured ports) — a true superset of worktree-dash.
- **Multi-repo features.** One session can span several repos: it owns a *feature* whose worktrees
  share a name across repos (that name is what ties them together). Add a repo **up front** (intake
  "also touches" multi-select) or **on the fly** (the "＋ repo" button, or claude itself via
  `wt-studio add-repo <repo>`). Adding a repo creates a same-named worktree there and grants the live
  session access via claude's `/add-dir` — so one conversation edits multiple repos, all tracked as
  one feature in the rail + the menubar.
- **Session management.** Rename, deactivate (stop the process, keep it resumable) / reactivate,
  delete. A **⚙ Connections** panel configures GitHub (via `gh`) / GitLab / Asana.
- **Sessions are real `claude` processes** inside **tmux** (dedicated socket, chrome-free
  config so it reads native). Embedded xterm terminal, multiple tabs addressed by their
  tmux window id, and a split pane that is its own independent shell in the same worktree.
- **Baked-in worktrees.** No external `wt` script — creation is native: `git worktree add`
  off the default branch, plus copying the gitignored bits a plain add drops
  (`.idea/runConfigurations/*.xml`, `.env`, `config/*-config.js`).
- **Hook-driven status.** A per-session `--settings` file wires Claude Code lifecycle
  hooks (SessionStart / PreToolUse / Notification / Stop / …) to the app — working /
  waiting / idle / stopped, pushed live over SSE. Your global settings are untouched.
- **Resume after shutdown.** A `{ session → id }` registry + `claude --resume`; tmux
  sessions persist and are reattached (tabs reconciled). Restart the app and sessions come back.
- **Dev servers per worktree** — start / stop / status via `lsof` on configured ports.

## Requirements

- macOS, Node ≥ 22, `git`, and **tmux** (`brew install tmux`).
  (22 is a hard floor, not a preference: the transcript index is built on `node:sqlite`.)
- `claude` (Claude Code) on PATH. Optional: `gh`, `glab` for issue sources.

## Run

```sh
cd /path/to/worktree-studio   # wherever you cloned it
npm install          # node-pty + spawn-helper perms, BUILDS THE FRONTEND
npm start            # → http://127.0.0.1:7788
```

To have it running whenever your Mac is, install the launchd agent instead —
`./install.sh --autostart` starts the server at login, restarts it if it dies, and
links the SwiftBar menubar plugin. `./uninstall.sh` reverses both. Alfred users:
double-click `alfred/Worktree Studio.alfredworkflow`, then type `wt`. See
[MANUAL.md](MANUAL.md#start-it-at-login-macos).

The UI is the SvelteKit app in `client/`, built to static files that the daemon serves
itself — there is no second server and no second port. `npm install` builds it (that is
the one moment the network is already assumed); `npm start` only starts the daemon, so it
stays fast and works offline. **After changing anything in `client/src`, rerun
`npm run build`** — or use `cd client && npm run dev`, which is what that loop is for.
If the build is missing the daemon refuses to start and says so.



## Configuration

`~/.config/worktree-studio/config.json` (seeded on first run from your
`worktree-dash` config when present):

| Key | Meaning |
|---|---|
| `baseDirs`, `scanDepth` | where to discover repos + their worktrees |
| `web.port` | dashboard port (default 7788, bound to 127.0.0.1) |
| — | *(not config)* the API token lives at `~/.local/state/worktree-studio/token`, mode 0600. Every request needs it; see `docs/api.md`. |
| `claude.cmd` | command used to launch a session (default `claude`) |
| `copyPatterns` | gitignored files carried into new worktrees (per-repo or `default`) |
| `copyAlways` | files copied in **whether or not git ignores them** (JetBrains run configs by default) |
| `worktrees` | where a repo's worktrees live: `{ layout: nested\|sibling\|external, dir, root }` |
| `featureIdentity` | what makes two worktrees the same feature: `{ strategy: basename\|branch\|manifest, branchPattern, branchFlags }` |
| `groups` | manual feature groups: `[{ name, members: ["repo/branch-or-wtname"] }]` |
| `concurrency` | run 2–3 features at once: `{ enabled, offsetStep, maxSlots, repos }` |
| `start.<repo>` | `{ cmd, ports }` dev-server launch config |
| `sources.gitlab` | `{ enabled, host, token, project }` (or install `glab`) |
| `sources.asana` | `{ enabled, token, workspace }` |

`worktrees`, `featureIdentity`, `copyPatterns`/`copyAlways` and `concurrency` are
conventions rather than settings — each changes behaviour across the whole app, and
a wrong choice fails in ways that are not obvious from the key name.
**`docs/config.md`** documents all four properly, with worked examples.

## Layout

```
server/
  server.ts            Express + SSE + WebSocket terminals
  config.ts            config load/seed
  git.ts               repo + worktree discovery
  worktree.ts          native `wt` (create/remove + copy gitignored files)
  multiplexer/         index (tmux selector) · tmux driver
  sessions.ts          session lifecycle: create / promote / restore
  status.ts            hook-settings generator + event→state machine
  servers.ts           dev-server start/stop/status
  identity.ts          which worktrees are "the same feature"
  broadcast.ts         the SSE fan-out (topology · session-state · ci)
  review.ts hunks.js diff.js   commits, structured diffs, hunk-level staging
  transcripts.ts transcript-index.js   transcript reader + sqlite search/telemetry
  pricing.ts           the maintained price table every dollar figure derives from
  sources/             freetext · github · gitlab · asana adapters
  webui.ts             which frontend is served, and the boot-token injector
client/                the served UI (SvelteKit → client/build); see client/README.md
```

## Tests

```sh
npm test               # worktree logic, branch derivation, hook state machine, parsing
```

## Docs

- **`MANUAL.md`** — what the app does, screen by screen.
- **`docs/api.md`** — the HTTP + SSE + WebSocket contract, derived from `server/`.
- **`docs/config.md`** — worktree layout, feature identity, copy patterns, concurrency.
- **`client/README.md`** — the SvelteKit UI: stores, the event stream, the panels.
