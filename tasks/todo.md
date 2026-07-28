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

