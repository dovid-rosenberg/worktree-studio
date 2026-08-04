# Worktree Studio — build plan

Single web app unifying: pluggable intake → seeded Claude Code session (CLAUDE.md)
→ promote to worktree (native `wt` baked in) → embedded multiplexer terminals
(tabs + pop-out) → hook-driven status → dev-server control → resume-after-shutdown.

## Stack
- Node 22 + Express + `ws` + `node-pty`; vanilla-JS frontend + xterm.js (vendored).
- Multiplexer abstraction: zellij (0.44) + tmux drivers; auto-detect.
- Claude Code integration: per-session `--settings` hook file → POST status to server.

## Build checklist — all shipped (2026-07-23)

Ticked retroactively: these were never checked off during the build, and the
"Review — built & verified" section below is the evidence they all landed. File
names here are pre-migration (`.js`, `public/`, zellij, pop-out); the modules are
`.ts`, there is one UI, tmux is the only driver, and pop-out is gone.
- [x] Scaffold, deps, node-pty spawn-helper fix, xterm vendored
- [x] Environment recon (zellij installed, claude 2.1.218, gh present)
- [x] server/util.js — exec/git/json helpers, tilde expand, id gen
- [x] server/config.js — load/seed ~/.config/worktree-studio/config.json
- [x] server/git.js — scan repos + worktrees, default branch, merged state
- [x] server/worktree.js — native `wt`: create/remove + copy gitignored patterns
- [x] server/multiplexer/{index,tmux,zellij}.js — session/tab/attach/capture/popout
- [x] server/status.js — hook receiver + settings generator + state machine
- [x] server/sources/{freetext,github,gitlab,asana}.js — seed adapters
- [x] server/sessions.js — registry, create, promote, popout, restore, tabs
- [x] server/servers.js — dev-server start/stop/status per worktree
- [x] server/server.js — Express + WS + SSE wiring
- [x] public/* — UI (rail, session dock w/ xterm tabs, intake modal, servers)
- [x] bin/wt-studio.js — CLI launcher
- [x] tests — worktree logic, sources, status state machine
- [x] Browser end-to-end verification

## Review — built & verified 2026-07-23

All modules built; every core mechanism verified end-to-end in the browser:
- [x] UI renders (dark/light, matches the mockups) · mux badge shows `zellij`
- [x] Session create (API + intake modal) → real process in a zellij session
- [x] Embedded xterm ⇄ zellij ⇄ pty ⇄ WebSocket: two-way I/O confirmed
- [x] Seed prompt passed into the session's first message
- [x] Promote → native worktree on a new branch + `.env`/run-config/dev-config copied
- [x] Live SSE updates (promote flipped header, rail, footer, server bar instantly)
- [x] Dev server start (python http.server on :9911 came up + served)
- [x] Intake modal: source tabs, GitLab/Asana correctly disabled, GitHub issue picker
- [x] GitHub `gh` adapter runs + fails gracefully (repos are non-GitHub-hosted)
- [x] REAL claude → hooks → status: `claude -p` flipped state + captured claudeSessionId
- [x] Resume-after-restart: "restored N session(s)" on boot
- [x] Unit tests 7/7 pass

### Bugs found & fixed during the build
- node-pty prebuilt `spawn-helper` shipped non-executable → `posix_spawnp failed`.
  Fixed with `bin/fix-pty.js` (chmod +x), wired into `postinstall`.
- zellij IPC socket path exceeded macOS's 103-byte limit under the long default
  `$TMPDIR` → sessions failed to start. Fixed by pinning `ZELLIJ_SOCKET_DIR=/tmp/zellij`
  in the driver env AND in the pop-out command (so the native terminal attaches the same socket).

## Merge — worktree-dash + Studio into one product (2026-07-23)

Full merge (Plan B), Fleet manages all worktrees. Built + verified:
- [x] `server/servers.js` — lsof→cwd running detection + guarded start + restart
- [x] `server/features.js` — grouping (manual + auto-shared-name + singles), main excluded
- [x] `server/sessions.js` — worktree↔session index + `adopt()` ("Start session here")
- [x] `server/server.js` — unified `/api/state` (worktree-dash-compatible + `session`) + `/api/group/*` + adopt
- [x] `server/config.js` — `groups` + `runConfigs` + `save()`
- [x] UI — Work/Fleet toggle; Fleet table (real features render); Work rail grouped by feature
- [x] Surfaces — SwiftBar (`swiftbar/worktrees.10s.sh` + `wts-action.sh`) & Alfred read `/api/state`; `core.sh` retired
- [x] `install.sh`
- [x] Tests 11/11 (grouping incl. manual/auto/singles)
- [x] Verified: `/api/state` shows 7 real features; Fleet run-stack + lsof detection + stop&switch (throwaway BE+FE); SwiftBar/Alfred render from live API; Work view no regression

Follow-up (not blocking): run-config import from `.idea`/`.vscode`/`.zed` (`/api/runconfigs*`).

## Post-merge fixes + features (2026-07-23)
- [x] Fix: claude launch dropped `-n` (installed claude rejects it — was blocking session start)
- [x] Fix: seed prompt injected after claude is ready (SessionStart hook + fallback), single-line
- [x] Intake: separate short Name field (branch no longer the whole prompt); form resets on open
- [x] Session mgmt: rename / deactivate+reactivate / delete
- [x] Connections settings UI (GitHub status, GitLab/Asana tokens), persisted to config
- [x] **Multi-repo features:** session owns feature + repos[]; `addRepo` (same-named worktree +
      `/add-dir`); triggers = intake "also touches" (up-front) + "＋ repo" button (on-the-fly) +
      `wt-studio add-repo` CLI (claude, via $WT_STUDIO_SESSION). Verified across 3 throwaway repos.
- [x] realpath-robust session↔worktree matching; rescan on promote/add-repo. 14/14 tests.

### Known environment blocker (not an app bug)
David's global `~/.claude/settings.json` has `permissions.defaultMode: "auto"`, invalid for the
installed claude → every interactive session opens with a settings-error dialog. Fix: set it to a
valid mode (`default` or `acceptEdits`), OR point `claude.cmd` at a claude that accepts "auto".

### Deliberately NOT done
- Multi-agent support (OpenAI/Codex/etc.) — feasible via an agent-adapter layer, deferred per David.

### Follow-ups
- Run-config import; claude-triggered add-repo could become a formal tool/hook; live end-to-end
  multi-repo run once the global defaultMode is valid.

### Notes / follow-ups
- Your repos are not GitHub-hosted, so the GitHub source lists nothing; the GitLab
  source is the real one for you — install `glab` or set `sources.gitlab.token`+`project`.
- promote / new-tab / close use native `prompt()`/`confirm()` (works in a real browser;
  they only block the automation extension). Could become inline UI later.
- zellij `dump-screen` on an unattached background session returns empty — fine, since
  hooks are the primary status source, not screen-scraping.


---

# Stack-start reliability — "the BE does not seem to be running" (2026-08-04)

Investigated against the live daemon, not from reading alone.

## What is NOT broken (proved by reproduction)

`/group/start` on `iso-mfa-totp` today answers `{ok:true, started:2, total:2, failures:[]}`.
The BE binds 1231/1232/1233/1239/1999, `discoverRunning()` maps its pid back to the
worktree, and the state payload reports `running:true` for both members. Command,
config, deps and discovery are all sound. The historical failure left a launch banner
with zero bytes after it and no tracked record; that process is gone, so I will not
claim a cause I cannot replay.

## The real defects

### 1. A member that cannot start is dropped silently  <- the reported symptom
`/group/start`: `toStart = members.filter(m => !m.running && m.canStart)`, then
`res.json({ ok: failures.length === 0, started, total: toStart.length })`.

`canStart = configured && !depsMissing`. A worktree made by `wt` has no node_modules --
that is the normal state of a fresh worktree, and demonstrably was this BE's state until
`install__iso-mfa-totp.log` (Aug 3 15:58). So the BE was filtered out before any launch
attempt and the response was `{ok:true, started:1, total:1, failures:[]}` -- identical to
full success. Half a stack, reported as a win.

`total` counts what was attempted, so it can never reveal the omission.
`test/api-routing.test.ts:189` currently enshrines this.

- [ ] Report skipped members: `{started, total, skipped:[{repo,reason}], failures}` with
      `total` = the members that should be up.
- [ ] `ok` stays a real verdict: false when a member was skipped for a fixable reason.
- [ ] Surface it in the UI -- a stack start that skipped a member must say so.

### 2. `start()` reports "spawned", not "listening"
The readiness poll is `for (let i = 0; i < 16 && ports.length; i++)`. With no ports it
never runs, so `ok:true` means `spawn()` returned. It also skips the port-in-use
pre-check. `ab-iso-fe` and `ab-su` are the string form (`"npm start"` -> `ports: []`) and
are rescued only because `concurrency.repos` happens to carry `WTS_FE_PORT`. A repo in
the string form with no concurrency entry gets neither check.

- [ ] Derive ports for the string form where knowable; when genuinely unknown, report the
      result as unverified rather than as success.

### 3. Editor opens one repo, not the feature
`ActionBar` calls `openEditor(session.worktreePath)` -- the primary worktree only.
`/group/open` already opens every member (WebStorm has no `openGroup`, so it loops
`open` per path). The feature-level button is right; the session-level one is not.

- [ ] Session "Open in editor" opens every repo the session spans.

### 4. Tracked pid can be the wrapper, not the listener
FE tracked pid 96036 = `npm start`; the listener is 96262 = `webpack`. `stop()` kills the
process group so it works, but the pid Studio tracks and the pid it shows disagree.

- [ ] Cosmetic; note only unless it costs something.

## Not a defect: commit message style
`POST /sessions/:id/commit` takes `message` verbatim from the request body. Studio never
generates a commit message, so there is nothing for a Claude memory to influence -- the
memory shapes what Claude Code writes inside a session, not what Studio's commit box
submits.

## Done (2026-08-04)

- [x] **1. Skipped members are named.** `/group/start` and `/group/restart` return
      `{ok, started, total, skipped:[{repo,path,reason}], failures}`. `total` counts what
      should be up; `ok` is false when anything was skipped. Reasons are the two real
      causes: "dependencies not installed" / "no start command configured for this repo".
      An already-running member is NOT a skip -- nothing to fix there.
- [x] **1b. `/group/restart` answers a verdict.** It discarded every result and returned
      a hardcoded `ok:true`.
- [x] **2. "Spawned" vs "listening".** `servers.start()` returns three-valued `listening`:
      true / false / undefined (nothing checkable). The poll result used to be computed
      and thrown away. A member that spawned but never bound now counts as a failure.
- [x] **3. Editor opens the whole feature.** `POST /open` takes `paths` as well as `path`,
      dedupes, and uses the editor's `openGroup` template when it has one. The session
      button calls `openSessionRepos()` and is labelled with the count.

Server 602 tests, client 106, `tsc --noEmit` and `svelte-check` clean.

## Found while verifying: the concurrency port shift is half-implemented

`concurrency.repos` gives each FE repo `portEnv: { WTS_FE_PORT: <port> }`, and Studio
passes it into the launch env at `base + slot*100`. **No FE repo reads `WTS_FE_PORT`** --
grepped `merchant-v3`, `ab-iso-fe`, `ab-su`: zero references. They bind their hardcoded
port on every slot.

The BE is fine: `accept-blue/config/index.js` does `Nconf.env({separator: '__'})`, which
is exactly why `api__port_su` etc. work.

So today, running two features at once shifts the BE and not the FE, and the second
feature's FE hits EADDRINUSE on the shared port. Proven live: `fix-google-pay-mobile`
holds slot 1, Studio waited on 3130, vite bound 3030.

Studio now *detects* this rather than failing silently -- when the expected ports stay
down but the worktree is listening on others, `start()` returns `boundElsewhere` and the
failure reads "started on port 3030 instead of the port this feature's slot expects".

- [ ] The actual fix is in the FE repos (have vite/webpack read `WTS_FE_PORT`), or give
      `config.start` a `portFlag` so Studio can pass `-- --port <n>`. Outside this repo;
      David's call.
