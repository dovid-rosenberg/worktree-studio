# Worktree Studio

**One place to start, watch, and steer Claude Code sessions — from any source, into a worktree, without leaving the loop.**

The origin of work is a *real Claude Code session* (booted on your `CLAUDE.md`), not a form.
Start one from free text, a GitHub / GitLab issue, or an Asana task; it runs in an
embedded terminal backed by a persistent tmux session. When it's clearly real work,
**promote** it — one click creates a worktree (run configs + local files carried in)
and the *same session continues into it*. Status is pushed by Claude Code hooks;
sessions survive a shutdown and resume where they left off.

## Two views, one engine

The app has one engine (this server) and two focused surfaces you toggle between:

- **Work** — the session cockpit: feature-grouped rail + embedded terminal + intake + promote.
- **Fleet** — a terminal-free manager of **all** worktrees under your base dirs, grouped into
  **features** (BE+FE by shared name + manual groups). Group-level start / stop / restart /
  stop&switch, cleanup (merged → remove), and "Start session here". This is the worktree-dash
  role, absorbed. The SwiftBar menubar + Alfred read the same `/api/state` (no more `core.sh`).

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
  one feature in Fleet + the menubar.
- **Session management.** Rename, deactivate (stop the process, keep it resumable) / reactivate,
  delete. A **⚙ Connections** panel configures GitHub (via `gh`) / GitLab / Asana.
- **Sessions are real `claude` processes** inside **tmux** (dedicated socket, chrome-free
  config so it reads native). Embedded xterm terminal, multiple tabs, and a **Pop out**
  button that opens the *same live session* in a native terminal window via a grouped
  tmux session — closing it never orphans the embedded terminal.
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

- macOS, Node ≥ 18, `git`, and **tmux** (`brew install tmux`).
- `claude` (Claude Code) on PATH. Optional: `gh`, `glab` for issue sources.

## Run

```sh
cd ~/worktree-studio
npm install          # node-pty + spawn-helper perms, vendors xterm, BUILDS THE FRONTEND
npm start            # → http://127.0.0.1:7788
```

The UI is the SvelteKit app in `client/`, built to static files that the daemon serves
itself — there is no second server and no second port. `npm install` builds it (that is
the one moment the network is already assumed); `npm start` only starts the daemon, so it
stays fast and works offline. **After changing anything in `client/src`, rerun
`npm run build`** — or use `cd client && npm run dev`, which is what that loop is for.
If the build is missing the daemon refuses to start and says so.

`public/` is the previous UI. It is still in the tree and still works: `WTS_UI=legacy
npm start` serves it instead. Exactly one of the two owns `/`.

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
| `start.<repo>` | `{ cmd, ports }` dev-server launch config |
| `sources.gitlab` | `{ enabled, host, token, project }` (or install `glab`) |
| `sources.asana` | `{ enabled, token, workspace }` |

## Layout

```
server/
  server.js            Express + SSE + WebSocket terminals
  config.js            config load/seed
  git.js               repo + worktree discovery
  worktree.js          native `wt` (create/remove + copy gitignored files)
  multiplexer/         index (tmux selector) · tmux driver
  sessions.js          session lifecycle: create / promote / popout / restore
  status.js            hook-settings generator + event→state machine
  servers.js           dev-server start/stop/status
  sources/             freetext · github · gitlab · asana adapters
  webui.js             which frontend is served, and the boot-token injector
client/                the served UI (SvelteKit → client/build); see client/README.md
public/                the previous UI, unserved unless WTS_UI=legacy
```

## Tests

```sh
npm test               # worktree logic, branch derivation, hook state machine, parsing
```
