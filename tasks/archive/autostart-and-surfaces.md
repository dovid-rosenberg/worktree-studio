# Autostart + surfaces (menubar, Alfred), and retiring worktree-dash

Branch: `feat/autostart-and-surfaces`

## Context

- `~/worktree-dash` is the predecessor project. It runs on **:7777** under
  `~/Library/LaunchAgents/com.worktree-dash.plist` (RunAtLoad + KeepAlive) and owns
  the SwiftBar plugin currently in the menubar
  (`~/.swiftbar/plugins/worktrees.10s.sh` → `~/worktree-dash/swiftbar/`).
- Worktree Studio has **no** autostart. `install.sh` only does `npm install` plus a
  SwiftBar symlink — and that symlink has never won the slot.
- Studio's own SwiftBar plugin exists but predates sessions-as-first-class,
  tickets/MRs, runs, and concurrency slots.
- `alfred/` has **no workflow bundle** — only `filter.sh` and `action.sh`. Nothing is
  importable, and `action.sh` hardcodes `$HOME/worktree-studio` (wrong checkout path).

## Plan

### 1. Autostart via launchd
- [ ] `launchd/com.worktree-studio.plist.template` — placeholders for node binary,
      repo path, state dir.
- [ ] `EnvironmentVariables.PATH` must include `/opt/homebrew/bin` — launchd gives a
      bare PATH and `server.ts` hard-exits when `tmux` is missing.
- [ ] Pin the absolute nvm node path at install time (node is not on launchd's PATH).
- [ ] `RunAtLoad` + `KeepAlive`; stdout/stderr → `~/.local/state/worktree-studio/studio.log`.
- [ ] `install.sh --autostart` renders the template and `launchctl bootstrap`s it.
- [ ] `uninstall.sh` (new) reverses agent + SwiftBar symlink, keeps config.

### 2. Retire worktree-dash
- [ ] Run `~/worktree-dash/uninstall.sh` (unloads the :7777 agent, drops the symlink).
- [ ] Verify nothing listens on :7777 and the plist is gone.
- [ ] OPEN QUESTION: delete/archive `~/worktree-dash` and `~/.config/worktree-dash`,
      or leave the checkout in place, disabled?

### 3. Menubar rewrite (`swiftbar/worktrees.10s.sh`)
- [ ] Title reflects attention first: waiting agents, else working, else running servers.
- [ ] Sessions section: state dot + activity, ticket link (`sourceUrl`), repos spanned.
- [ ] Features section: members, ports, concurrency slot, start/stop/restart.
- [ ] Keep the "not running" vs "refused the token" distinction already there.
- [ ] Install the symlink; verify by running the script by hand against a live server.

### 4. Alfred workflow, for real
- [ ] Build `alfred/Worktree Studio.alfredworkflow` (info.plist + scripts, zipped) so
      it imports with a double-click.
- [ ] Fix the hardcoded helper path in `action.sh` (resolve from the script's location,
      same trick the SwiftBar plugin already uses).
- [ ] Search both worktrees and sessions; modifier keys for editor / Finder / start /
      stop / open in cockpit.
- [ ] Document the keyword and the modifiers in MANUAL.md.

### 5. Docs + verification
- [ ] MANUAL.md: autostart section, menubar section, Alfred section.
- [ ] `npm run check` + the test suite.
- [ ] Prove the agent survives a `launchctl kickstart -k` and the UI answers on :7788.

## Review

Done, and live on this machine:

- **launchd agent** — `launchd/com.worktree-studio.plist.template` + `install.sh
  --autostart` + a new `uninstall.sh`. Installed and verified: `state = running`,
  survives `launchctl kickstart -k`, cockpit answers 200, tmux resolves under the
  agent's PATH. It points at the **main checkout**, deliberately — not at this
  worktree, which disappears when the branch lands.
- **worktree-dash retired** — its own `uninstall.sh` unloaded the :7777 agent and
  removed its menubar plugin. Nothing listens on 7777; no dash plists remain. The
  checkout at `~/worktree-dash` and `~/.config/worktree-dash` are untouched, pending
  a decision.
- **Menubar rewritten** — sessions are the first section now (waiting first, with
  activity, spanned repos and ticket links); features keep the stack controls and
  gain slot + merged marks. Title shows one number chosen by urgency. Under launchd
  the "not running" branch offers `kickstart` instead of a terminal.
- **Daemon health in the menubar** — the plugin asks launchd, not just the API, and
  names five states (healthy / hand-started / duplicate / wedged / crash-looping).
  All five exercised by hand. A Start button is offered only where starting is
  actually the fix: with `KeepAlive`, a crash-looping daemon is already being
  restarted, so the honest action there is "read the log".
- **Alfred is real** — `alfred/info.plist` + `alfred/build.sh` produce an importable
  `Worktree Studio.alfredworkflow`. `action.sh` no longer calls a helper at a
  hardcoded `~/worktree-studio` path (which is why start/stop silently did nothing);
  both scripts are self-contained, because Alfred copies a workflow on import.
  Failures notify instead of vanishing.
- Tests: 702 server + 141 client, typecheck included. All pass.

Not verified: the workflow bundle has not been imported into Alfred's UI end to end
— `plutil -lint` passes and the object graph mirrors a working installed workflow,
but the first real import is the actual proof.

Open: delete or keep `~/worktree-dash`; the SwiftBar symlink points at the main
checkout, so it serves the OLD menubar rendering until this branch merges.
