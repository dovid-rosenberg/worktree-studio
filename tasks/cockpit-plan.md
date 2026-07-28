# Worktree Studio — Cockpit Upgrades: execution plan

Branch: `feature/cockpit-upgrades`. Scope = everything from the review **except** the
standalone/Electron packaging. (The `mockups/cockpit.html` reference is gone —
the mockups were removed once the UI shipped.)

Each task below is sized for **one subagent**. Tasks that touch the same hot files
(`server/server.js`, `public/app.js`) are **sequenced** to avoid merge clobber; tasks
on disjoint files may run in **parallel** (marked ∥). Every task lands with tests green
(`npm test`) and, where it has UI, a browser screenshot verifying it against the mockup.

Hot shared files: `server/server.js`, `public/app.js`, `public/index.html`,
`public/style.css`, `server/config.js`. Keep edits additive and section-scoped.

---

## Phase 1 — Harden the core  (1 agent, lands first, blocks nothing downstream but everything sits on it)

**T1. Safety & reliability fixes**
- Command injection: route `/api/open` and `/api/group/open` through `shq()` instead of
  raw `{path}`/`{paths}` interpolation into `bash -lc` (`server.js:360,447`).
- Crash-proofing: add an async-handler wrapper (`const A = fn => (req,res)=>fn(req,res).catch(e=>res.status(500).json({error:e.message}))`)
  and apply to every async route; add `process.on('unhandledRejection')` + `uncaughtException`
  logging guards. Fix the specific throwers: `/api/worktrees` (missing branch/name),
  `/api/group/session` (empty members), `/api/group/delete` (missing repoObj),
  `/api/worktrees/adopt` (missing worktreePath).
- `restore()` must **skip `active === false`** sessions (`sessions.js:355`) — deactivated
  sessions should stay stopped across app restarts, not silently relaunch.
- Perf: decouple `servers.discoverRunning()` from the SSE broadcast. Cache it on its own
  ~3s interval (+ invalidate on start/stop), and have `buildState()` read the cache. Today
  every Claude hook (`PreToolUse`/`PostToolUse`) triggers a full-system `lsof` sweep.
- Wire all four test files into `npm test` (`package.json` — add `features.test.js`,
  `multirepo.test.js`).
- Add regression tests: injection payload is quoted/rejected; malformed body → 400 not crash;
  `restore()` leaves a deactivated session stopped.
- Files: `server/server.js`, `server/servers.js`, `server/sessions.js`, `package.json`, `test/`.

## Phase 2 — Test the marquee flows  ∥ (1 agent, test/ only — safe to run alongside any later phase)

**T2. Coverage for the untested lifecycle**
- `sessions.promote` (real tmpdir git repo): worktree created, primary repo updated, branch set.
- `activate`/`restore` resume: with a stub mux, assert `-r <claudeSessionId>` is built when present,
  `restarted` vs `resumed` fallback, and (post-T1) deactivated sessions are skipped.
- `applyHook`: event→state transitions incl. `SessionStart` capturing `claudeSessionId`,
  `SessionEnd`→`active=false`.
- `worktree.remove` + `expandPattern` glob edges; `servers.discoverRunning` fed canned `lsof -F`
  strings (pure parser test, no real lsof).
- Files: `test/` only.

## Phase 3 — Diff & Commit  (backend agent → frontend agent; the headline feature)

**T3a. Review backend**
- New `server/review.js`: `status(worktreePath, baseBranch)`, `fileDiff(worktreePath, file)`,
  `stage(paths)`, `commit(worktreePath, message, {amend})`. All via `execFile` arg-arrays (no shell).
  Diff = working tree + branch-vs-base. Reuse existing `/api/group/pr` for the PR step.
- Endpoints: `GET /api/sessions/:id/changes`, `GET /api/sessions/:id/diff?file=`,
  `POST /api/sessions/:id/commit`. For multi-repo sessions, aggregate across `s.repos`.
- Tests for `review.js` against a real tmpdir repo.
- Files: `server/review.js`, `server/server.js`, `test/`.

**T3b. Changes tab (frontend)**  — depends on T3a
- New dock tab "✎ Changes" with the changed-file count badge; file list (status + ±counts +
  stage checkbox), unified diff pane, commit bar (message, amend, "run tests first",
  Commit / Commit&PR). "Draft message from the diff" = send a one-line ask into the session.
- Match the shipped `.changes*`/`.commitbar` classes in `client/src/lib/components/review/`.
- Files: `public/app.js`, `public/index.html`, `public/style.css`.

## Phase 4 — Live server logs  (1 full-stack agent)  — after Phase 3 (shares server.js/app.js)

**T4. Log streaming**
- Backend: `WS /ws/logs?worktreePath=` tails the per-worktree log file `servers.js` already
  writes (`fs.watch` + incremental read; send last ~300 lines on connect). Guard the path against
  the tracked set (no arbitrary reads).
- Frontend: "▸ Logs" dock tab — repo/port selector, follow toggle, clear, "tailing" indicator.
- Files: `server/server.js`, `server/servers.js`, `public/app.js`, `public/index.html`, `public/style.css`.

## Phase 5 — Attention notifications  (1 frontend-leaning agent)  — after Phase 4

**T5. Notify when a session needs you**
- Frontend: detect SSE transitions to `waiting` (and optionally `idle`/turn-done); fire
  `Notification` API (request permission on first enable), optional sound, tab-title + favicon
  badge, and a Fleet-tab count badge. Clicking focuses that session.
- Config: notify prefs (`notify.waiting`, `notify.sound`, `notify.idle`) in `config.js`,
  surfaced in Settings, persisted via `/api/settings`.
- Also fix here: **WS terminal auto-reconnect** (`app.js:319`) so terminals revive after the
  server restart that `restore()` handles.
- Files: `public/app.js`, `public/index.html`, `public/style.css`, `server/config.js`, `server/server.js`.

## Phase 6 — Flow: command palette · keyboard nav · split view  (1 frontend agent)  — after Phase 5

**T6. Keyboard-first cockpit**
- Command palette (⌘K): fuzzy jump to sessions + run commands (New, Promote ⌘↵, Review ⌘D,
  Run stack ⌘R, toggle Work/Fleet ⌘\). ⌘1–9 jump to sessions.
- Split view: second embedded terminal beside the first (two WS terminals; pick tab/session per pane).
- Also fix here: **tab-strip active-highlight desync** (track selected index in client state,
  `app.js:259/360`) and **`adoptWorktree` treating a 200 error-object as success** (`app.js:685`).
- Files: `public/app.js`, `public/index.html`, `public/style.css`.

## Phase 7 — Ports & CI + in-app config  (backend agent → frontend agent)  — after Phase 6

**T7a. CI + config backend**
- `GET /api/sessions/:id/ci` (or `/api/group/ci`): poll `gh pr checks` / `glab ci status` for each
  branch; return {state, passed, running, failed, url}. Cache briefly.
- Extend `/api/settings` to read/write `start.<repo>`, `editors`, `groups`, and notify prefs.
- Files: `server/server.js`, `server/config.js`, `test/`.

**T7b. Ports/CI/config UI (frontend)**  — depends on T7a
- Serverbar: port chips become "open in browser" links; add the PR/CI pill (checks summary,
  click → open PR).
- Settings: editable Dev-servers rows, Editors, Groups, Notifications (see mockup `.srvcfg-row`/`.setsec`).
- Files: `public/app.js`, `public/index.html`, `public/style.css`.

---

## Sequencing summary
- **Serial spine (shared server.js/app.js):** T1 → T3a → T3b → T4 → T5 → T6 → T7a → T7b.
- **Parallel:** T2 (tests) can run alongside the entire spine. T3a/T7a (backend) can start while
  the previous phase's frontend is in review.
- Review checkpoint after each phase; `npm test` green + browser screenshot vs mockup before moving on.

## Deliberately out of scope
- Standalone / Electron packaging and the Windows multiplexer driver (deferred per David).
- Embedded Monaco editor (the diff panel covers ~80% of the need); revisit later.
