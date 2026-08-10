# 02 — Functionality

Every bug found in the August 2026 review, with repro. Findings that were corrected or
demoted by the adversarial pass are marked inline. The bottom section records what was
**refuted** so nobody re-raises it.

Provenance markers used throughout:

- **reproduced** — the reviewer ran it against a live sandbox daemon and observed the failure.
- **verified** — read in the source at the cited line and confirmed by reading, not running.
- **inferred** — reasoned from the code; not executed. Treat as a hypothesis to confirm first.

All line numbers are against commit `5ce2f4c`. Another agent commits to this repo — if a
line is off by a few, re-grep for the quoted code rather than assuming the finding is stale.

**Volume, honestly:** this document carries 45 items. Five are critical or high enough to
schedule this week (BUG-01 through BUG-05); the long tail from BUG-19 onward is roughly
twenty small, individually cheap fixes — mostly one-line validation guards and doc
corrections. Do not read the length as forty urgent problems.

---

## What was and was not actually exercised

Four reviewers ran live daemons against disposable sandboxes. **None of them touched the
user's real daemon on 7788, `~/.config/worktree-studio`, or `~/.local/state/worktree-studio`;
none modified the repo.** Ports used were 8137, 8143, 8147, 8148, 8149. All sandboxes were
removed and all spawned daemons/tmux sessions killed and verified gone.

**What was genuinely exercised, against a live daemon over HTTP:**

- The full main loop: intake → promote → multi-repo add-repo fan-out → feature grouping →
  concurrency slot allocation → dev-server start/stop/restart → run configurations →
  structured diff → hunk staging → PR attempt → delete. 37 SSE topology frames were captured
  and cross-checked against `/api/state`; all matched.
- Concurrency in depth: port offsetting per slot, `portFlag` end to end (`node server.js
  --port 4320`), `configPatch` rewriting, slot exhaustion (409, no partial launch, no leak),
  `releaseSlotIfIdle` refusing to free a slot while a sibling repo is still listening, and
  both `basename` and `manifest` identity strategies as a controlled A/B.
- Hostile input across the API: argv discipline (branch names with spaces, quotes,
  `;rm -rf x`, unicode reach git as literal arguments), `sha` validation against
  `?sha=--output=/tmp/pwn` on `/diff` and `/commit-detail`, out-of-range and 200 000-element
  hunk selections, FTS5 search injection and `limit` clamping, malformed JSON (400),
  oversized bodies (413), and the Host/Origin/token guard. **All of this held.** That is a
  real result, not an absence of one.
- Degenerate git states: a repo with zero commits, a repo on a detached HEAD, a repo with no
  `origin`, and `gh` present but unauthenticated.
- `npm test` was run once and is green (708 server + 149 client tests).

**What was NOT exercised — treat findings that depend on these as unverified:**

- **The real Claude agent.** Every reviewer stubbed `claude.cmd` (to `bash`, or to
  `exec sleep 100000`). So hook-driven session state, transcripts, usage insights, resume,
  `/add-dir` grants, and the terminal WebSocket are all out of scope. The transcript search
  routes were exercised only against an empty index; the SQL and clamping were read, not run.
- **Missing tmux.** `server/multiplexer/tmux.ts:112` hardcodes
  `/opt/homebrew/bin:/usr/local/bin` into the PATH it uses for every tmux invocation, so
  stripping tmux from PATH does not hide it, and no reviewer would move the user's binary.
  BUG-36 is code-read only.
- **Missing `gh`/`glab`.** Same PATH problem; both binaries are installed on this machine.
  The adjacent cases (no `origin`, unauthenticated `gh`) were tested instead and reported
  honestly. The forge **success** path is untested — BUG-30 is read-only analysis.
- **The very first `npm install` / client build.** `client/build` and `node_modules` already
  existed in the pinned checkout and installing would write into the repo. "npm install
  builds the frontend" is verified by reading `bin/build-client.ts` and the postinstall hook.
- **`./install.sh --autostart`.** It writes a real launchd agent into the user's
  `~/Library/LaunchAgents` and would collide with the running daemon. BUG-39 is inferred.
- **The browser UI.** Nothing was rendered. Every claim about empty states, toasts and
  buttons comes from reading `client/src` — chiefly `client/src/lib/ops.svelte.ts`,
  `Rail.svelte`, `IntakeModal.svelte`, `DiffViewport.svelte`.
- **Real dependency installation.** All fixture repos had zero dependencies, which is what
  surfaced BUG-09, but also means no reviewer ever watched a real `npm install` succeed.
- **Multi-slot depth.** Concurrency was tested up to slot 2; `redis__db`/`slotEnv` semantics
  beyond env emission, and the `branch` identity strategy, were not tested.

**Sandbox artefacts worth knowing about:**

- The reviewers shared the `-L wt-studio` tmux socket with the user's real daemon. Panes
  inherit the environment of whichever process started the tmux server, which on this machine
  was the user's daemon — that contamination is why BUG-39's launchd-PATH claim is inferred
  rather than reproduced.
- One reviewer's probe of `POST /api/open` launched a real WebStorm window on the user's
  desktop. Harmless; that route was not probed again.
- One reviewer's `baseDirs` pointed at `/private/tmp/...` rather than `/tmp/...` because git
  realpaths worktree paths on macOS. That was sandbox noise, not a product bug — but see
  BUG-26, where the same symlink asymmetry *is* a real defect.

---

## Track A — Crash and data-loss

### BUG-01 — `Servers.start()` spawns without an `'error'` listener; one HTTP request kills the daemon
**Severity: critical · Effort: trivial · Confidence: reproduced (twice, by two independent reviewers) · Adversarial verdict: CONFIRMED**

Files: `server/servers.ts:812`, `server/servers.ts:829`, `server/crash.ts`,
`server/server.ts:769-776`, `server/orchestrator.ts:203-207`

**Repro (reproduced three times from a cold start):**
1. Create a feature with a worktree in a repo that has a `config.start` entry.
2. Remove the worktree directory behind Studio's back: `rm -rf <worktree>`. The scan cache
   still lists it, and it still renders with `canStart: true` (see BUG-02), so the Run button
   stays live on screen.
3. Press "Run stack" — `POST /api/v1/group/start {"group":"<name>"}`. Also reproduced via
   `POST /api/v1/servers/start` with a nonexistent `worktreePath`.

Observed: curl reports `status=000` (connection dropped, no HTTP response at all). Daemon log:

```
[wt-studio] fatal uncaughtException — exiting so this is visible instead of running on in an unknown state
Error: spawn bash ENOENT
  syscall: 'spawn bash', path: 'bash', spawnargs: [ '-lc', 'npm start' ]
```

`ps -p <pid>` → dead. Every session's PTY, the SSE fan-out, the HTTP server and the CI feed
go with it.

**Root cause.** `servers.ts:812` is `spawn('bash', ['-lc', cmd], { cwd: worktreePath, detached: true, stdio: [...], env })`
inside a `try/finally` that only closes the log fd. There is no `child.once('error', …)`.
Node reports a failed spawn — including `ENOENT` for a missing *cwd* — asynchronously as an
`'error'` event; unhandled, it becomes an `uncaughtException`, and `crash.ts` classifies
anything outside `CONNECTION_ERROR_CODES` (EPIPE/ECONNRESET/stream codes) as fatal and exits.
This is the **only** spawn site in the codebase missing the guard: `runner.ts:159` has
`child.once('error', e => this.#finish(id, null, \`failed to start: ${e.message}\`))`,
`servers.ts:663` (`installDeps`) has `child.once('error', () => resolve(-1))`, and `hunks.ts:64`
handles it too.

Secondary damage: `servers.ts:829` writes `this.tracked[worktreePath] = { pid: child.pid, … }`
and `_save()`s synchronously, *before* the error event lands. `child.pid` is `undefined` for a
failed spawn, so a junk record is persisted — visible at the next boot as
`dropped stale tracked pid undefined for …`.

**Fix.** Attach the listener before returning, and only record a process that exists:

```ts
const spawnFailure = new Promise<Error | null>((r) => { child.once('error', r); setImmediate(() => r(null)); });
const err = await spawnFailure;
if (err) return { ok: false, error: `could not start ${repo}: ${err.message}` };
if (!child.pid) return { ok: false, error: `could not start ${repo}: no pid` };
this.tracked[worktreePath] = { pid: child.pid, repo, log, startedAt };
```

Add an `fs.existsSync(worktreePath)` precheck at the top of `start()` returning
`{ ok: false, error: 'the worktree directory no longer exists' }` — better message for the
common cause. The precheck is **complementary, not a substitute**: it closes the case, the
listener closes the class.

**Acceptance:** a `POST /api/v1/servers/start` against a deleted worktree returns
`{ ok:false, error: … }`, the daemon is still serving afterwards, and `servers.json` gains no
record.

> Note for triage: this was reported twice (from `/group/start` and from `/servers/start`).
> It is **one** defect with **one** fix. Do not count it as two.

---

### BUG-03 — `Servers.stop()` falls back to slot-0 ports, so stopping one feature SIGTERMs another feature's dev servers
**Severity: critical · Effort: small · Confidence: reproduced · Adversarial verdict: CONFIRMED**

Files: `server/servers.ts:912-918` (`_portsFor`), `server/servers.ts:441` (`launchOpts`),
`server/servers.ts:920-962` (`stop`), `server/server.ts:601-608`, `server/server.ts:611-624`

**Preconditions (real, and stated by the finding):** concurrency enabled and the repo present
in `concurrency.repos`. Otherwise `launchOpts` returns `{ports: []}` and `_portsFor` falls back
to the repo's configured base ports, which is the pre-existing non-concurrent design.

**Repro:**
1. `concurrency`: `offsetStep: 10`, `api.portEnv.APP_PORT = 4100`. Two features `feat-x` and
   `feat-y`, each with an `api` worktree.
2. `POST /api/group/start {"group":"feat-x"}` → `feat-x` takes slot 0, binds 4100.
   `servers.json` slots = `{"feat-x":0}`. `feat-y` has **no** slot.
3. `POST /api/servers/stop {"repo":"api","worktreePath":".../api/.worktrees/feat-y"}` —
   `feat-y` was never started. Response: `{"ok":true,"killed":true}`. `lsof` shows **feat-x's**
   server on 4100 is gone.
4. Realistic UI path, same result: adopt a session on `feat-y`, leave it stopped, then
   `DELETE /api/sessions/<id>` (the Close-session button). Verified twice with `lsof` before/after.

**Root cause.** `launchOpts` resolves `const slot = this.slots.get(feature) ?? 0`. That `?? 0`
conflates "this feature has no slot" with "this feature is at slot 0", so a slot-less feature
derives the *base* ports. `stop()`'s port sweep then kills whatever holds them, guarded only by
`pid !== t.pid` — nothing checks that the port belongs to this worktree — and returns
`killed: true`. Compounding: `/sessions/:id/servers/stop` and `DELETE /sessions/:id` loop
`servers.stop(...)` with **no `m.running` guard**, while `/group/stop` and `/group/close`
(`orchestrator.ts:216`, `:288`) do filter on `m.running`. That asymmetry is why the group verbs
mostly dodge this.

**Fix — two halves, both needed.** (a) Make the absence of a slot distinguishable: have
`launchOpts`/`_portsFor` return `[]` when `this.slots.get(feature) === undefined` and
concurrency is enabled for the repo. (b) In `stop()`, only SIGTERM a port's pid if that pid's
worktree (via `discoverRunning` / `_pidInfo`) is the worktree being stopped.

**Acceptance:** with `feat-x` on slot 0 and `feat-y` slotless, stopping `feat-y` returns
`{ok:true, killed:false}` and `feat-x`'s port is still LISTEN.

---

### BUG-04 — A dev server slower than the start poll loses its concurrency slot while alive; the slot is reissued and both features collide on the port
**Severity: critical · Effort: small · Confidence: reproduced · Adversarial verdict: PARTLY — mechanism confirmed, one timing detail corrected (below)**

Files: `server/servers.ts:842-852` (the 16×500 ms poll), `server/servers.ts:864`
(`_beginStart`/`_endStart` bracket), `server/servers.ts:420-430` (`reconcileSlots`),
`server/servers.ts:386-391` (`releaseSlotIfIdle`), `server/server.ts:135`

**Repro:**
1. `maxSlots: 3`, `offsetStep: 10`, `api.portEnv.APP_PORT = 4100`. Feature `mixed` running at slot 0.
2. Give `api`'s `feat-y` worktree a `server.js` that `setTimeout(…, 25000)` before `listen()`.
3. `POST /api/servers/start` for `feat-y` → `{"ok":true, …, "listening":false}` after ~8 s.
   The process is alive and in `this.tracked`.
4. Read `servers.json` immediately: slots = `{"mixed":0}`. **feat-y's slot 1 has already been reclaimed.**
5. Start `feat-x` → gets slot 1 → `APP_PORT 4110` → `listening:true`.
6. Wait 25 s. `feat-x` log: "listening on 4110". `feat-y` log: `ERR EADDRINUSE on 4110`.
   feat-y's server is dead and nothing in Studio says why.

**Root cause.** `reconcileSlots` and `releaseSlotIfIdle` define "the feature is up" purely as
"something of it is LISTENING", never consulting `this.tracked` or `_trackedPidState()`.
`_beginStart`/`_endStart` bracket only `start()`'s own 8 s poll. `releaseSlotIfIdle`
additionally does not check `_starting` **at all** — a second, independent way to lose a slot
mid-launch.

> **Correction from the adversarial pass.** The original write-up said the sweep runs "every
> ~3 s". It does not — `watch.ts:50-51` sets `runningActiveMs: 8000` / `runningIdleMs: 120000`
> (the "3s" figure survives only in a stale comment at `server.ts:130-133`). This *strengthens*
> the repro: every start route calls `await refreshRunning()` immediately after `startAll`
> returns (`server.ts:594`, `:773`; `orchestrator.ts:207`), and `refreshRunning` calls
> `reconcileSlots` (`server.ts:135`). The slot is reclaimed **synchronously on the way out of
> the very request that started the slow server**, not up to 3 s later.

**Fix.** A feature is live if any key of `this.tracked` maps through `featureFor()` to it AND
`_trackedPidState()` says `'ours'`. Use that test alongside the listening test in **both**
`reconcileSlots()` and `releaseSlotIfIdle()`, and add the missing `_starting` check to
`releaseSlotIfIdle()`. Separately consider making the 8 s start poll configurable — it is short
for a real webpack/Next dev server.

**Acceptance:** a worktree whose server takes 25 s to bind still holds its slot at t=10 s, and
a concurrent start for another feature is given the *next* slot.

---

### BUG-05 — Manual `config.groups` under the default `basename` identity gets one slot **per member**: divergent ports and a config patch pointing at a dead port, reported as 3/3 ok
**Severity: high · Effort: small · Confidence: reproduced**

Files: `server/servers.ts:329-331` (`featureFor` → `identity.ofPath`),
`server/orchestrator.ts:186-199`, `server/servers.ts:437-457` (`launchOpts`),
`server/servers.ts:459-476` (`applyConfigPatch`), `server/identity.ts:154-166`

**Repro:**
1. `featureIdentity.strategy = 'basename'` (**the default**). `maxSlots: 3`, `offsetStep: 10`.
2. `config.groups = [{"name":"mixed","members":["api/alpha","web/beta","worker/gamma"]}]` —
   different worktree names per repo, which is the whole point of a manual group.
3. `concurrency.repos`: `api {APP_PORT:4100}`, `web {APP_PORT:4200, configPatch:{file:'src/config.ts', siblingRepo:'api'}}`,
   `worker {WORKER_PORT:4300, portFlag:'--port {port}'}`.
4. `web/.worktrees/beta/src/config.ts` contains `export const API = 'http://localhost:4100'`.
5. `POST /api/group/start {"group":"mixed"}` → `{"ok":true,"started":3,"total":3,"skipped":[],"failures":[]}`.
6. `servers.json` slots = `{"alpha":0,"beta":1,"gamma":2}`. `lsof`: 4100, 4210, 4320.
7. `cat web/.worktrees/beta/src/config.ts` → `'http://localhost:4110'`. Nothing listens on 4110;
   this group's backend is on 4100. **The user's gitignored config file has been persistently
   rewritten to a wrong value.**

Secondary: with `maxSlots: 2`, starting `mixed` → `{"ok":false,"error":"no free concurrency slot (max 2 running)"}`
with `slots = {}` — nothing was running at all, so the error text is actively misleading.

**Control that pins the cause:** set `featureIdentity.strategy = 'manifest'`, restart, start
`mixed` → slots `{"mixed":0}`, ports 4100/4200/4300, `config.ts` untouched. Fully correct.

**Root cause.** `config.groups` is honoured by `features.ts` for **grouping** but not by
`identity.ts` for **slot keying** unless the strategy is explicitly `manifest`. The two answers
are supposed to agree (identity.ts's own header says so) and under the shipped default they do not.

**Fix.** Make the manifest lookup unconditional — consult `config.groups` in `of()` regardless
of strategy, since a manual group is by definition an explicit statement of identity, then fall
through to the configured strategy. Failing that: warn loudly at `load()` when `cfg.groups` is
non-empty, `concurrency.enabled` is true and `strategy !== 'manifest'`; and have `/group/start`
refuse (or flag) a group whose members resolve to more than one identity.

**Acceptance:** with `strategy: 'basename'` and a manual group of three differently-named
worktrees, `POST /group/start` allocates one slot and leaves the sibling configPatch pointing at
the group's own backend port.

---

## Track B — Success that isn't success

### BUG-06 — `deleteBranches: true` silently does nothing for an unmerged branch, reported as a clean success
**Severity: high · Effort: small · Confidence: reproduced · Adversarial verdict: CONFIRMED**

Files: `server/worktree.ts:311-316`, `server/orchestrator.ts:315-318`,
`client/src/lib/ops.svelte.ts:617-632`

**Repro:**
1. Create and promote a feature; commit something on its branch so it is ahead of main.
2. `POST /api/v1/group/delete {"group":"<name>", "deleteBranches": true}` — or in the UI,
   Delete feature with "Also delete the branches" ticked (it is pre-ticked when any member is merged).
3. Response `{"ok":true,"results":[{"repo":"backend","ok":true}]}`. Toast: "Deleted `<name>`".
4. `git -C <repo> branch` → `feature/<name>` is still there.

**Root cause.** `worktree.ts:313-314` runs `git branch -d` and records only
`branchDeleted = d.code === 0`; stderr is discarded. `git branch -d` refuses an unmerged branch
with exit 1. `orchestrator.ts:317` builds `{ repo, ok: rr.ok, error: rr.ok ? undefined : rr.error }`
and never reads `rr.branchDeleted` — grepping the whole repo, `branchDeleted` has **no consumer
anywhere**, only its declaration (`worktree.ts:71`) and the two lines that set/return it. The
client reads only `r.ok`.

Nuance worth knowing: `DELETE /api/v1/worktrees` (`server/server.ts:746-753`) returns
`worktree.remove`'s `out` verbatim, so on *that* route the boolean does reach the wire. It is
the `/group/delete` path — the one the UI uses — that drops it.

**Fix.** Return `branchError: d.stderr.trim()` alongside `branchDeleted` from `remove()`; carry
both into each `/group/delete` result entry; have `deleteFeature`'s toast name any branch that
survived.

**Acceptance:** deleting a feature with an unmerged branch reports which branch was kept and why.

---

### BUG-07 — `POST /sessions/:id/commit` does `git add -A`, discarding the hunk-level staging built next door
**Severity: high (see caveat) · Effort: small · Confidence: reproduced · Adversarial verdict: CONFIRMED**

Files: `server/review.ts:331`, `server/server.ts:711-729`, `server/hunks.ts:1-11`

**Repro:**
1. In a worktree, modify a file so it produces two hunks; leave an untracked file lying around
   (`npm install`'s `package-lock.json` will do).
2. `POST /api/v1/sessions/:id/hunks/stage {"repo":"backend","file":"data.txt","hunk":0}` → ok.
   `git diff --cached` confirms exactly hunk 0 is in the index.
3. `POST /api/v1/sessions/:id/commit {"repo":"backend","message":"change line A"}` → `{"ok":true,"sha":"…"}`.
4. `git show --stat HEAD` → 2 files, +14/−2. **Both** hunks and the untracked `package-lock.json`
   were committed. `git status --porcelain` is empty.

**Root cause.** `review.ts:331` — `const add = list.length ? ['add', '--', ...list] : ['add', '-A'];`
where `list = paths || []`. Both an absent `paths` and `paths: []` take the `add -A` branch, so
there is **no** argument meaning "commit the index as it stands". `hunks.ts:1-2` and
`routes-review.ts:127-128` both state that hunk staging "coexists with (does not replace) the
file-level staging in `review.commit()`" — one feature destroys the other's work.

**Caveat on severity (from the adversarial pass).** Grepping `client/src`, nothing in the
SvelteKit client ever POSTs `/sessions/:id/commit`. Today the destructive combination is only
reachable via the API or an agent, so `high` is arguably generous — but it is a live trap for
the next UI that wires up a commit button, and the review panel's Stage buttons make it easy to
walk into.

**Fix.** With no `paths`, commit the index (skip `git add` entirely). Add an explicit
`all: true` flag for callers that want the sweep. Minimum viable: skip `add -A` when
`git diff --cached --quiet` reports a non-empty index.

**Acceptance:** stage one hunk, commit with no `paths`, and `git show --stat HEAD` contains only
that hunk.

---

### BUG-08 — A worktree with untracked files can never be deleted through the API, and Studio's own install-deps button creates the blocker
**Severity: high · Effort: medium · Confidence: reproduced · Adversarial verdict: CONFIRMED**

Files: `server/worktree.ts:309`, `server/orchestrator.ts:298-322`, `server/server.ts:746-753`,
`client/src/lib/ops.svelte.ts:628-631`

**Repro:**
1. Create a two-repo feature and promote it.
2. Press Install dependencies on each worktree (`POST /api/v1/worktrees/install-deps`). npm
   writes `package-lock.json`, which is untracked.
3. `POST /api/v1/group/delete {"group":"<name>"}` →
   `{"ok":false,"results":[{"repo":"backend","ok":true},{"repo":"frontend","ok":false,"error":"fatal: '…/frontend/.worktrees/<name>' contains modified or untracked files, use --force to delete it"}]}`.
   Retrying gives the identical error forever. There is no `force` parameter on `/group/delete`
   or on `DELETE /worktrees`, and grepping `server/` for "prune" returns nothing — there is no
   recovery route either.

**Root cause.** `worktree.ts:309` hardcodes `git worktree remove <path>`; `WorktreeRemoveOptions`
has no force field. Its own fallback error string reads `worktree remove failed (use force?)` —
the author knew. Neither caller accepts a flag. Compounding: `orchestrator.ts:308-314` runs
`servers.stop` then `manager.close(m.session.id)` **before** `worktree.remove`, so a failed
removal has already destroyed the agent, and the loop continues to the next member with no
rollback. And `ops.svelte.ts:630` collapses the whole `results` array into
`toast('Some removals failed')` — git's `use --force` line, the one actionable thing in the
response, is never shown.

Correction to the repro's detail: `git worktree remove` ignores gitignored paths, so
`node_modules` alone would not block; `package-lock.json` blocks only if untracked or
tracked-and-modified. That is a detail of one reproduction, not of the defect — *any*
untracked/modified file produces the same dead end.

**Fix — three separable pieces.** (a) Thread a `force` option through `worktree.remove` and both
delete routes, and have the UI re-prompt with the per-repo reason when a non-forced delete
fails. (b) Do the removals **first** and only kill sessions/servers for the members that
actually got removed. (c) Surface `results[].error` in the failure toast.

**Acceptance:** a delete blocked by an untracked file shows the git reason and offers a
force retry; the surviving worktree's session is still alive.

---

### BUG-31 — `Runner.logs()` claims "same contract as `Servers.logs`" and implements truncation, UTF-8 and `skipped` differently
**Severity: high · Effort: small · Confidence: verified**

Files: `server/runner.ts:236-263`, `server/runner.ts:30`, `server/servers.ts:999-1023`,
`server/servers.ts:197-229`

`runner.ts:238` states it outright. Three verified divergences:

1. **Rotation handling is opposite.** `Servers.logs` (`servers.ts:1015`):
   `const start = offset > size ? 0 : Math.max(0, offset)` — a shrunken file means it was
   truncated, so re-read from the start. `Runner.logs` (`runner.ts:253`):
   `Math.max(Math.min(opts.offset, size), size - TAIL_MAX_BYTES)` — when `offset > size` this
   clamps `from` to `size`, `from >= size` is true, and it returns `{ text: '' }` on **every
   subsequent poll** until the file grows past the stale offset.
2. **No line-boundary trim.** `Servers.readTail` (`servers.ts:226-229`) deliberately drops the
   clipped first line, "which also disposes of the half UTF-8 sequence an arbitrary byte offset
   can land in the middle of". `Runner.logs` slices at a raw byte offset and `toString('utf8')`s it.
3. **`skipped` is missing.** `Servers.logs` returns `{ offset, text, size, skipped }`;
   `Runner.logs` returns `{ offset, text, size }` and silently drops bytes.

`TAIL_MAX_BYTES = 512 * 1024` is declared twice (`servers.ts:197`, `runner.ts:30`) and
`readRange` is re-inlined at `runner.ts:256-263`.

**Why it matters.** A run log is truncated in exactly one ordinary case: `Runner.remove()`
deletes the file and `rerun()` recreates it at the same path while a panel is still polling.
From that point the Runs panel shows nothing for that run and never recovers — no error, it
just stops updating, which reads as "the run produced no output". The UTF-8 issue shows up as
mojibake on the first read of any run over 512 KB (any real test suite).

**Fix.** Extract `server/logtail.ts` exporting `readRange`, `readTail`,
`tail(file, {offset, lines})` and `TAIL_MAX_BYTES`, with `tail()` owning the whole rule
(rotation reset, line-boundary trim, cap, `skipped`). `Servers.logs` and `Runner.logs` both
delegate. See STYLE-26 — this is the same work item.

**Acceptance:** delete and recreate a run log mid-poll and the Runs panel resumes; both routes
return `skipped`.

---

### BUG-32 — "Is this run config a server?" is decided six ways; two parsers structurally cannot apply the rule the module calls authoritative
**Severity: high · Effort: small · Confidence: verified**

Files: `server/run-configs.ts:59` (`matchesStartCmd`), `:172`, `:193`, `:202`, `:243`, `:277`,
`:306`, `:351`, `:358`; `server/settings.ts:109`; `server/server.ts:850`

`matchesStartCmd()` carries an explicit docstring: *"A command that IS the repo's configured
start command is a server, whatever it is called… This beats the name heuristic outright."*
Six call sites decide `kind` with six different expressions:

| Site | Expression |
|---|---|
| JetBrains npm (172) | `matchesStartCmd(cmd, …) \|\| SERVER_NAME.test(script \|\| name)` |
| JetBrains mocha (193) | hardcoded `'task'` |
| JetBrains Node (202) | `matchesStartCmd(cmd, …) \|\| SERVER_NAME.test(name)` — name but not cmd |
| VS Code tasks (243) | `(t.isBackground ?? SERVER_NAME.test(t.script \|\| name))` — `matchesStartCmd` never called |
| VS Code launch (277) | `matchesStartCmd(cmd, …) \|\| SERVER_NAME.test(cmd) \|\| SERVER_NAME.test(name)` |
| Zed (306) | `SERVER_NAME.test(t.label)` only |

Worse: `discover()` does not even **pass** `opts.startCmd` to `parseVsCodeTasks` (`:351`) or
`parseZed` (`:358`), so those two parsers structurally cannot apply the rule.

**Why it matters.** `kind` routes the command into two completely different subsystems
(`server.ts:852` vs `:879`). A Zed `.zed/tasks.json` entry or a VS Code task whose command IS
`config.start[repo].cmd` — the exact case `matchesStartCmd` exists for — is classified `task`
and handed to `Runner`, which tracks it as a finite job: no concurrency slot, no port
pre-check, no `tracked` record, "Stop stack" cannot reach it, and it sits in the Runs panel as
a run that never finishes. The same command in a JetBrains XML or `launch.json` is correctly a
server. Two editors, same repo, same command, opposite behaviour, nothing on screen explains it.

**Fix.** One exported classifier, all parsers routed through it:

```ts
function kindOf(
  { cmd, name, hints = [] }: { cmd: string; name: string; hints?: (string | undefined)[] },
  worktreePath: string, startCmd?: string, isBackground?: boolean,
): RunKind {
  if (matchesStartCmd(cmd, worktreePath, startCmd)) return 'server';
  if (isBackground !== undefined) return isBackground ? 'server' : 'task';
  return [cmd, name, ...hints].some((s) => s && SERVER_NAME.test(s)) ? 'server' : 'task';
}
```

Pass `opts.startCmd` into `parseVsCodeTasks` and `parseZed`. Leave line 193 (mocha) as an
explicit `'task'` with its existing comment — "a test run is finite by definition" is a
genuinely different judgement.

**Acceptance:** a Zed task and a VS Code task whose command equals `config.start[repo].cmd` both
classify as `server`. One test assertion pins the rule for all four parsers.

---

### BUG-34 — Shipped `copyPatterns` defaults say `.ts` where every doc says `.js`: gitignored JS config is silently not copied into new worktrees
**Severity: high · Effort: trivial · Confidence: reproduced · Adversarial verdict: CONFIRMED (root cause verified against the commit)**

Files: `server/config.ts:86-88`, `README.md:45`, `MANUAL.md:461`, `MANUAL.md:639-643`,
`docs/config.md:156`, plus tests below.

**Repro:**
1. Repo with `src/config.js` in `.gitignore` (a JS project's local config).
2. Start a session on it; `POST /api/sessions/:id/promote`.
3. `ls <repo>/.worktrees/<name>/src` → "No such file or directory". `.env` was copied (it matches
   `.env`/`.env*`); `src/config.js` was not.

Seeded `config.json` on a clean first run contains `"config/*-config.ts"`, `"src/config.ts"`,
`"src/config/config.ts"`. All three docs document the `.js` forms.

**Root cause (verified against the commit).** `git show 676511e -- server/config.ts` contains
the hunk `- 'config/*-config.js', 'src/config.js', 'src/config/config.js'` → `+ …'.ts'`, plus
three `configPatch.file` rewrites. That commit's stated purpose was rewriting stale *module
specifiers*; these are glob patterns matched against the **user's** repo, where the extension is
a property of that repo, not of this codebase. Collateral damage.

**Locked in by a green suite.** `test/concurrency-wiring.test.ts:34,164,196-233`,
`test/config-merge.test.ts:58,189` and `test/config.test.ts:23`
(`const SHIPPED = ['src/config.ts', 'src/config/config.ts']`) all now assert the rewritten values.

**Existing users are stuck too:** `load()` unions shipped defaults into `copyPatterns.default`,
so the `.ts` entries are persisted in every `config.json` written since that commit and the
`.js` ones only return if re-added to `defaults()`.

**Fix.** Restore the three `.js` literals **and ship both extensions** (a missing file costs
nothing): `config/*-config.js`, `src/config.js`, `src/config/config.js`,
`config/*-config.ts`, `src/config.ts`, `src/config/config.ts`. Update the three test files.

**Acceptance:** promoting a JS repo with a gitignored `src/config.js` produces a worktree
containing it. The symptom in MANUAL's Troubleshooting §1 stops being normal behaviour.

---

### BUG-38 — `review.ts` reads working-tree diffs without the canonicalizing git flags that `hunks.ts` uses
**Severity: high · Effort: small · Confidence: verified**

Files: `server/review.ts:209-215`, `server/review.ts:273/281/289`, `server/hunks.ts:49`,
`server/hunks.ts:77`, `server/diff.ts:60-65`

`review.workingFileDiff()` and `hunks.unstagedDiff()` are the same function — try `git diff`,
and if it produced nothing check `git status --porcelain` for `??` and fall back to
`git diff --no-index -- /dev/null <file>`. The difference is that `hunks.ts` passes:

```ts
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-U3'];
```

with a comment stating exactly why: force `a/`+`b/` prefixes and plain output so neither the
user's global git config (`diff.mnemonicPrefix` gives `c/`+`w/`, `diff.noprefix` gives none) nor
an external difftool can change the bytes we parse. `review.ts:210` runs the bare command.

**Why it matters.** A user with `diff.noprefix = true` gets `--- server/review.ts` instead of
`--- a/server/review.ts`; `stripPrefix` (`diff.ts:60-65`) then chops the real first directory
and the parsed file's `path` becomes `review.ts`. The Changes pane mislabels every file in a
subdirectory. With `diff.mnemonicPrefix` the `c/`+`w/` prefix survives stripping, so the bug is
invisible until someone sets the other flag. Missing `--no-ext-diff` means a configured external
difftool can make review.ts's output unparseable while hunk staging keeps working — which reads
as "the diff view is broken" rather than "a git config is honoured in one place and not the other".

**Fix.** Have `review.ts` import `unstagedDiff` from `hunks.ts` (already exported) and delete
`review.workingFileDiff`. Add `...DIFF_FLAGS` to the `git show` invocations in
`review.commitDetail` (`:273/281/289`) — the `--format=` already suppresses the commit header.

**Acceptance:** a fixture test runs the review path with `-c diff.noprefix=true` and asserts the
parsed `file.path` still has its directory.

---

## Track C — Wrong answers and state confusion

### BUG-02 — A worktree deleted from disk is reported as `canStart: true`
**Severity: high · Effort: trivial · Confidence: reproduced · Adversarial verdict: CONFIRMED**

Files: `server/servers.ts:688-693` (`depsMissing`), `server/servers.ts:706-716` (`decorate`),
`server/git.ts` (`parseWorktrees` / `describeRepo`)

**Repro:** promote a session so `alpha/.worktrees/edges-one` exists; `rm -rf` it; wait for a
rescan; `GET /api/state` → the worktree is still present (git's `worktree list` reports it until
pruned) with `{"wtname":"edges-one","canStart":true,"depsMissing":false,"noStartCmd":false}`.

**Root cause.** `depsMissing()` opens with
`if (!fs.existsSync(path.join(worktreePath, 'package.json'))) return false;` — a vanished
directory yields `false`, i.e. "dependencies are fine". `canStart = configured && !deps`, and
`configured` is keyed on the **repo's** start command. Nothing upstream filters it out either:
`parseWorktrees()` ignores the `prunable` marker git emits, and `describeRepo()` pushes every
parsed entry with no existence test. Grepping `existsSync` across `server/` shows no
path-existence check anywhere in the topology build.

This is the precondition that makes BUG-01 reachable from an ordinary button.

**Fix.** Add an existence check in `decorate()` and surface it as its own reason:

```ts
const present = fs.existsSync(worktree.path);
return { …, missing: !present, canStart: present && configured && !deps,
         skipReason: !present ? 'worktree is gone from disk' : … };
```

`start-report.toSkip()` then names it in `skipped` for free and the card can offer
`git worktree prune`.

**Acceptance:** deleting a worktree from disk makes it render unstartable with a reason.

---

### BUG-09 — `depsMissing` is unsatisfiable for a dependency-free package, and "Install dependencies" reports success while changing nothing
**Severity: medium (demoted from high) · Effort: small · Confidence: reproduced by three independent reviewers · Adversarial verdict: CONFIRMED, severity demoted**

Files: `server/servers.ts:688-693`, `server/servers.ts:639-672` (`installDeps`),
`server/servers.ts:706-716`, `server/start-report.ts:67`, `server/start-report.ts:74`

**Repro:**
1. Repo whose `package.json` has a `start` script and **no** dependencies
   (`{"name":"backend","scripts":{"start":"node server.js"}}`). Promote to a worktree.
2. `POST /api/group/start` → `{"ok":false,"started":0,"skipped":[{"reason":"dependencies not installed"}]}`.
3. Do what the message says: `POST /api/worktrees/install-deps` → `{"ok":true}`. Log reads
   `up to date in 271ms`. npm (verified on 11.14.1) writes `package-lock.json` and creates **no**
   `node_modules`.
4. `GET /api/state` → `depsMissing` still true, `canStart` still false. Repeat forever.
   Only `mkdir node_modules` broke the deadlock.

**Root cause.** `depsMissing()` is exactly *package.json exists && node_modules does not*. npm
only creates `node_modules` when there is something to install, so the predicate is
unsatisfiable for a zero-dependency package. `installDeps()` reports npm's exit code faithfully
and never re-checks the predicate it was invoked to satisfy.

Other false positives of the same predicate: devDependencies-only projects that were pruned,
pnpm workspaces with the store elsewhere, and **Yarn PnP / Bun** — none of which create a
top-level `node_modules`. Yarn PnP is the credible real-world case, and there the predicate is
permanently wrong for every repo in the workspace.

**Correction from the adversarial pass — patch the right layer.** The refusal lives in
`start-report.ts:74` (`toStart` filters on `!m.running && m.canStart`), **not** inside
`servers.start()`, which has no deps check at all. There *is* an ungated route —
`POST /api/v1/servers/start` calls `startAll` directly — but grepping `client/src` for
`servers/start` returns zero hits, so it is a fix hook, not an existing workaround.

**Fix.** Make the predicate account for there being nothing to install:

```ts
depsMissing(worktreePath) {
  const pkgPath = path.join(worktreePath, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  if (fs.existsSync(path.join(worktreePath, 'node_modules'))) return false;
  if (fs.existsSync(path.join(worktreePath, '.pnp.cjs'))) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }).length)
      return false;   // nothing to install — node_modules will never appear
  } catch { /* unreadable package.json — fall through */ }
  return true;
}
```

And have `installDeps` re-evaluate `depsMissing` after a zero exit, returning
`{ ok: true, stillMissing: true }` when the two still disagree, so the UI can say something
truthful instead of offering the same button again.

**Acceptance:** a zero-dependency repo starts its dev server without an install; a Yarn PnP
worktree is not flagged.

---

### BUG-12 — `defaultBranch()` accepts `rev-parse --abbrev-ref HEAD`'s output uncritically, so the review baseline follows whatever the main checkout is on
**Severity: medium (demoted from high) · Effort: small · Confidence: reproduced · Adversarial verdict: PARTLY — mechanism confirmed, severity and framing corrected**

Files: `server/git.ts:109-114`, `server/review.ts:77-85`, `server/worktree.ts:209-214`,
`server/git.ts:117-121` (`describeRepo`)

**Repro (as reported):**
1. Repo `detached`: two commits, then `git checkout HEAD~1` (detached HEAD — the ordinary state
   during `git bisect` or after checking out a tag).
2. `GET /api/state` → the repo reports `"defaultBranch": "HEAD"`.
3. Create a session, promote to `feat/det`, make a real commit in the new worktree.
4. `GET /api/sessions/:id/commits` → `{"…","base":"3319c26da8…","defaultBranch":"HEAD","commits":[],"uncommitted":{"fileCount":0,…}}`.
   The commit that was just made is invisible in the Changes pane, with nothing explaining why.

**Root cause.** `git.ts:109` tries `symbolic-ref --quiet --short refs/remotes/origin/HEAD`, then
falls back to `git rev-parse --abbrev-ref HEAD`, then `'main'` — and `return cur || 'main'`
accepts the literal string `HEAD` because it is non-empty. `review.base()` then computes
`merge-base HEAD HEAD`, which is the worktree's own tip, so the baseline equals the branch tip
and the diff is empty by construction. `worktree.defaultBase()` has the byte-identical fallback,
so a promote in such a repo silently branches off the detached commit. `describeRepo` computes
`defHead` from `refs/heads/HEAD` → `''`, which silently disables merged/not-merged detection.

> **Correction from the adversarial pass — re-frame before you fix.** The exact repro needs two
> things at once: no `refs/remotes/origin/HEAD` (a normal `git clone` sets it, so this is the
> minority case) **and** a detached *main* checkout. That is narrow. But the finding under-sells
> the broader defect it exposes: the same fallback returns whatever branch the main checkout
> happens to be on, so a main checkout parked on `feat/x` — far more common than detached, and
> needing no missing `origin/HEAD` — silently makes `feat/x` the review baseline and the promote
> base for every new worktree. **Justify the fix on the common case, not the detached one.**

**Fix.** Reject the sentinel in one place:

```ts
const cur = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
if (cur && cur !== 'HEAD') return cur;
for (const c of ['main', 'master', 'develop'])
  if (await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${c}`])) return c;
return 'main';
```

Apply the same guard to `worktree.defaultBase()`. Do this **together with STYLE-12** (the three
drifted default-branch resolvers) so the rule lands once.

**Acceptance:** a repo with no `origin/HEAD` whose main checkout is detached, or on a feature
branch, still reports a real default branch and shows the worktree's commits.

---

### BUG-13 — A vanished worktree produces a clean, empty review instead of an error
**Severity: medium · Effort: small · Confidence: reproduced**

Files: `server/server.ts:645-669`, `server/server.ts:671-696`, `server/review.ts:77-85`,
`server/util.ts` (`git()`)

**Repro:** promote a session owning `alpha/.worktrees/edges-one`, `rm -rf` it, then
`GET /api/sessions/:id/commits` → HTTP 200
`{"repos":[{"repo":"alpha","worktreePath":"…","branch":"feat/…","base":"main","defaultBranch":"main","commits":[],"uncommitted":{"fileCount":0,"added":0,"deleted":0}}]}`
— byte-for-byte identical to a healthy branch with nothing on it. If the user's work was in that
worktree, the Review pane tells them everything is fine and empty. `base: "main"` is a
fabrication; no git command succeeded.

**Root cause.** `util.git()` returns `''` for any non-zero exit, including a missing cwd.
`review.commits()` reads `''` as "no commits", and `review.base()` ends
`return local || remote || defaultBranch`, so with both merge-bases empty it hands back the raw
default-branch *name* as though it were a resolved base. Neither route checks the worktree path
exists.

**Fix.** Guard each loop body in both routes with
`if (!fs.existsSync(entry.worktreePath)) { out.push({ repo, worktreePath, unavailable: true, reason: 'worktree is gone from disk' }); continue; }`.
Structurally better, and it also covers BUG-12: give `review.base()` a `null` return for "could
not determine" so callers must handle it, rather than laundering a failure into a plausible ref
name.

**Acceptance:** `/sessions/:id/commits` for a deleted worktree returns an `unavailable` row, not
a clean zero-commit review.

---

### BUG-14 — A nonexistent `baseDir` empties the dashboard while `POST /settings` answers `ok: true`
**Severity: medium · Effort: small · Confidence: reproduced**

Files: `server/git.ts:57-62` (`walkTree`), `server/server.ts:399-403`, `server/server.ts:103-114`

**Repro:** `POST /api/settings {"baseDirs":["/tmp/does-not-exist-at-all"]}` → 200
`{"ok":true,"baseDirs":["/tmp/does-not-exist-at-all"], …}`. Then `GET /api/state` → `repos: []`.
Every repo, worktree and feature is gone from the UI. The daemon log says nothing.

**Root cause.** `walkTree()` swallows the readdir failure with a bare `catch { return; }`, so
`scan()` returns `[]` rather than throwing. The error handling deliberately added at
`server.ts:106-114` — whose comment describes exactly this scenario ("POST /settings with a
mistyped baseDir echoed the new dirs back with ok:true while the topology kept serving the old
repos") — never fires, because the scan does not throw. It fires only for an exception thrown
past the readdir.

**Fix.** Have `walkTree` collect what it could not read (`catch (e) { unreadable.push({ dir, error: msg(e) }); return; }`)
and let `scan` return it alongside the repos; `POST /settings` echoes `warnings` and the rescan
logs one line per unreadable baseDir. Cheap 90% version: `stat` each expanded baseDir in the
`POST /settings` handler and return the missing ones.

**Acceptance:** a mistyped baseDir comes back as a named warning, and the boot line/log says
which directories were scanned.

---

### BUG-15 — Promote silently creates a different branch than requested when the worktree **name** collides
**Severity: medium · Effort: small · Confidence: reproduced**

Files: `server/worktree.ts:235-246`

**Repro:**
1. Promote session A: `{"branch":"feat/ünïcode-ok","name":"edges-one"}` → `.worktrees/edges-one`
   on `feat/ünïcode-ok`.
2. Promote session B asking for a **different, unused** branch but the same name:
   `{"branch":"feat/second","name":"edges-one","confirm":true}` → 200, `ok:true`, with
   `"branch":"feat/edges-one-2"`, `"name":"edges-one-2"`,
   `"warnings":["name was taken — using \"edges-one-2\"", …]`.
3. `git worktree list` confirms the branch on disk is `feat/edges-one-2`. `feat/second` was never
   taken — it simply was not used. The only warning talks about the *name*, so nothing connects
   the two.

**Root cause.** `worktree.ts:239-243`:

```ts
while (fs.existsSync(dest) || (await branchExists(repoPath, branch))) {
  n += 1; wtName = `${baseName}-${n}`;
  dest = layoutMod.destFor(layout, repoPath, wtName);
  branch = branch.replace(/[^/]+$/, wtName);
}
```

The condition is an `||`, so a free branch name is rewritten purely because the *directory* name
was taken; and `branch.replace(/[^/]+$/, wtName)` rewrites the last path segment — a branch with
no slash is replaced wholesale. Keeping name and last segment in sync is a reasonable default
for a branch *derived* from the name; it is applied unconditionally to a caller-supplied branch.

**Fix.** Track the two collisions separately and only rewrite a branch the caller did not pin;
push a second warning whenever `branch` differs from what was asked for.

**Acceptance:** promoting with an explicit unused branch and a taken name dedupes the directory
and keeps the branch.

---

### BUG-17 — Worktrees named in a manual group **also** appear as their own singleton features, with their own Start button and their own slot
**Severity: medium · Effort: small · Confidence: reproduced**

Files: `server/features.ts:60-71`, `server/state.ts:222-224`

**Repro:** with `strategy: 'basename'` (default) and
`config.groups = [{name:'mixed', members:['api/alpha','web/beta','worker/gamma']}]`,
`GET /api/state` → `features` contains `mixed [api,web,worker]` **and** `alpha [api]` **and**
`beta [web]` **and** `gamma [worker]`. Each singleton is independently startable with its own
slot key (confirmed by `servers.json` showing `{"alpha":0,"beta":1,"gamma":2}`).
Control: `strategy: 'manifest'` → only `mixed`.

**Root cause.** The dedupe test compares the auto-identity against manual **group names**, which
never match member basenames. Under `manifest` the identities collapse to the group name and the
name test happens to work, which hides the bug for that one strategy.

**Fix.** Build a Set of worktree paths claimed by manual groups and skip those worktrees when
building `autofeat`, instead of comparing names. Lands naturally alongside BUG-05.

**Acceptance:** a manually grouped worktree appears exactly once in `state.features`.

---

### BUG-30 — The GitLab adapter's `glab` branch silently drops the search query and labels issues with the merge-request sigil
**Severity: medium · Effort: trivial · Confidence: verified**

Files: `server/sources/gitlab.ts:60-98`, `server/sources/github.ts:30-32`

Three verified divergences between the CLI and REST branches of one lookup:

- **`q` is dropped on the CLI path.** `gitlab.ts:63` builds
  `['issue','list','-P','30','-F','json']` and never uses the `q` it destructured at `:60`.
  The REST branch (`:72`) applies it (`&search=…`), as does `github.ts:30-32`. So typing in the
  intake picker filters GitHub issues and GitLab-via-REST issues, and does nothing at all for
  GitLab-via-`glab` — which is the branch that runs whenever `glab` is installed, i.e. the
  common case. The search box *appears broken*: it accepts input and returns the same
  unfiltered 30 issues.
- **Two different subtitles for one issue.** CLI branch (`:67`): `` `!${it.iid}` ``. REST branch
  (`:74`): `` `#${it.iid}` ``. `!` is the merge-request sigil; `#` is the issue sigil. Which one
  you see depends on whether a tool is installed on the machine.
- **`seed()`'s two branches** (`:82-88`, `:92-98`) return byte-identical object literals.

**Fix.** Add `if (q) args.push('--search', String(q))` to the CLI branch, matching
`github.ts:30-32`. Settle on `#${iid}` (what both providers' web UIs use), applied after the
branch rather than inside each. Hoist `seed()`'s shared tail so only "where does the
`GitlabIssue` come from" differs.

**Acceptance:** typing in the intake picker filters GitLab issues with `glab` installed; the
subtitle is `#<iid>` on both paths.

---

### BUG-33 — `has()` probes for a CLI under a different PATH than the one used to run it
**Severity: medium · Effort: trivial · Confidence: verified (code); the failure mode is inferred**

Files: `server/util.ts:72` (`has`), `server/servers.ts:167`, `server/runner.ts:24`,
`server/forge.ts:35`, `server/multiplexer/tmux.ts:128`, `server/sources/github.ts:5`,
`server/sources/gitlab.ts:6`, `server/server.ts:297`, `server/forge.ts:341`

Six modules each declare
`const ENV = { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:' + process.env.PATH }`
(verified byte-identical). `has(cmd)` probes with `execFileSync('command', ['-v', cmd], { shell: '/bin/bash' })`
and `execFileSync('/usr/bin/which', [cmd])` — a non-login, non-interactive bash inheriting the
daemon's bare `process.env.PATH` with **no** Homebrew prefix. So "does `gh` exist?" and "run
`gh`" answer against two different PATHs. Note `tmux.available()` (`tmux.ts:207`) deliberately
does *not* use `has()` — it shells `tmux -V` through the augmented ENV, which suggests this was
already worked around once, in one place.

**Inferred failure mode** (not reproduced — would require moving the user's binaries): under a
launchd PATH lacking `/opt/homebrew/bin`, `has('gh')` returns false while `run('gh', …, {env: ENV})`
succeeds. `has()` gates three user-visible decisions: `forge.ts:341` (`isInstalled`, which builds
the `installed` provider list), `server.ts:297` (`tools: { gh, glab }` in the settings modal),
and `sources/github.ts:21` / `sources/gitlab.ts:58` (`isEnabled`). A false negative makes
`GET /sessions/:id/ci` short-circuit at `forge.ts:445` and answer `hasPR:false` for every repo
without shelling out, and `failureReason` reports "no forge CLI installed" for a machine that has
it — while `openPullRequest` would have worked, because it tries every provider regardless.

**Fix.** Export one `CHILD_ENV`/`CLI_ENV` from `util.ts` (STYLE-15), and make `has()` probe under
it. Leave `run()`'s default env untouched so nothing else moves.

**Acceptance:** with a minimal PATH, `has('gh')` and `run('gh', …)` agree.

---

### BUG-36 — Missing tmux is logged and then ignored; the daemon boots anyway, contradicting MANUAL's "exits immediately"
**Severity: medium · Effort: trivial · Confidence: inferred (code-read; could not be run — `tmux.ts` hardcodes the Homebrew PATH, so tmux cannot be hidden without touching the user's install)**

Files: `server/server.ts:81-92`, `MANUAL.md:87-89`

```ts
const mux = (await tmux.available()) ? tmux : null;
if (!mux) { console.error('[wt-studio] tmux not found — install it (brew install tmux) and retry.'); }
else { console.log(...); }
...
const manager = new SessionManager(cfg, mux || tmux, identity);
```

There is no exit between the error and the `mux || tmux` fallback, which restores exactly what
the check rejected. MANUAL.md:88 states plainly: *"Studio exits immediately when it cannot find
`tmux`"* — and uses that claim to justify the launchd PATH the installer generates.

**Fix.** Make the doc true: `process.exit(1)` after the error (every other fatal boot condition
already exits cleanly, e.g. the EADDRINUSE path). Then `mux` is never null and the fallback goes.

**Acceptance:** with tmux absent, the daemon prints the error and exits non-zero.

---

### BUG-10 — `featureLinks` and `featureColors` survive feature deletion and are silently re-attached to any new feature with the same name
**Severity: medium · Effort: trivial · Confidence: reproduced**

Files: `server/server.ts:310-334`, `server/server.ts:335-373`, `server/orchestrator.ts:298-322`,
`server/server.ts:519-534`

**Repro:**
1. `POST /api/v1/features/hpalpha/links {"ticket":"https://tracker.example/OLD-1"}` → ok, written
   to `config.json`.
2. `POST /api/v1/group/delete {"group":"hpalpha","deleteBranches":true}` → ok, worktree gone.
3. `config.json` still contains `featureLinks: {"hpalpha": {"ticket":"…/OLD-1"}}`.
4. Create a completely unrelated session named `hpalpha` in a **different** repo and promote it.
5. `GET /api/v1/state` → the new feature renders a ticket chip pointing at the old, unrelated ticket.

Feature names are slugs of free text, so collisions are cheap. Worse: the promote-time copy at
`server.ts:526-532` explicitly refuses to overwrite an existing ticket ("a ticket the user set
by hand outranks the one intake guessed"), so the stale entry actively **blocks** the correct one.

Additionally `POST /features/:name/links` does not check the feature exists — writing a link for
`no-such-feature-xyz` persists it — so the file also collects entries that were never real.

**Fix.** Delete `cfg.featureLinks[name]` and `cfg.featureColors[name]` in `/group/delete` after
a fully successful removal, and save. Optionally reject `POST /features/:name/links` for a name
`resolveGroup` cannot find, the way the colour route already rejects an unknown colour.

**Acceptance:** deleting a feature removes its links/colour from `config.json`; a new feature
with the same name starts blank.

---

### BUG-11 — The `expect` stale-hunk guard is silently skipped for the scalar form the API accepts
**Severity: medium · Effort: trivial · Confidence: reproduced**

Files: `server/hunks.ts:150-157`, `server/hunks.ts:41`, `server/routes-review.ts:66-70`

**Repro:** with a file that has two hunks, stage hunk 0 so one unstaged hunk remains (now index
0, header `@@ -12,4 +12,4 @@ line K`). Send a request asserting the **wrong** header in the
scalar form:

```
POST /api/v1/sessions/:id/hunks/stage {"repo":"backend","file":"data.txt","hunk":0,"expect":"@@ -1,1 +1,1 @@"}
→ {"ok":true,"hunks":[0], …}   and the hunk is staged.
```

Expected `{"ok":false,"error":"the diff changed since it was loaded — reload and try again"}`,
per the guard's own docblock at `hunks.ts:130-134`: *"without the guard a stale index would
silently stage the WRONG hunk."*

**Root cause.** `hunks.ts:150` — `if (Array.isArray(expect)) { … }`. The declared type is
`expect?: string | string[]` (`hunks.ts:41`, and `routes-review.ts:68` agrees), so a scalar is a
documented, type-checked input; it just falls through the only branch that checks anything. The
pairing matters because the routes deliberately support scalar shorthand for the selection too
(`hunk: 0`), so `{hunk, expect}` as a matched scalar pair is the natural way to call this. The
bundled Svelte client always sends arrays (`DiffViewport.svelte:171,186`), so the shipped UI is
unaffected — this bites API/CLI callers and agents.

**Fix.** One line:
`const want = Array.isArray(expect) ? expect : expect != null ? [expect] : [];` then run the
existing loop over `want`.

**Acceptance:** a scalar `expect` that does not match the current header returns the stale-diff
refusal.

---

### BUG-16 — `/group/stop` and `/group/close` answer a bare `{"ok":true}`; `Servers.stop()` cannot report failure at all, and never escalates past SIGTERM
**Severity: medium · Effort: small · Confidence: reproduced**

Files: `server/orchestrator.ts:212-224`, `server/orchestrator.ts:283-295`,
`server/servers.ts:921-965`

**Repro:** start feature `feat-x` across three repos; replace `worker`'s worktree `server.js`
with one that installs `process.on('SIGTERM', () => {})` and keeps listening; restart that
member. `POST /api/group/stop {"group":"feat-x"}` → `{"ok":true}`. `lsof`: 4300 is still LISTEN.

**Root cause.** `stop()`'s return type is literally `{ ok: true; killed: boolean }` — `ok` is a
constant, there is no failure channel, and it never escalates to SIGKILL. The two group verbs
discard even the `killed` boolean. (The slot was correctly retained by `releaseSlotIfIdle`, so
state stays consistent — the user is simply told the stack is down when it is not.)

**Fix.** Have `stop()` re-check the worktree's ports after the settle and return
`{ok, killed, stillListening: [ports]}`, escalating to SIGKILL before giving up. Then have both
routes return `{ok: results.every(r => r.ok), results}` the way `/group/delete` already does.

**Acceptance:** a SIGTERM-ignoring server is reported as still listening.

---

### BUG-18 — `attachable` is computed only by the promote route, so an adopted session's Start reports full success for a half-started stack
**Severity: medium · Effort: small · Confidence: reproduced**

Files: `server/server.ts:486-493` (`attachableFor`), `server/server.ts:543` (its only caller),
`server/server.ts:915-919` (`POST /worktrees/adopt`), `server/orchestrator.ts:327-366`
(`/group/session`), `server/server.ts:568-597`

**Repro:**
1. Feature `feat-z` exists in `api` and `web` (same worktree name).
2. `POST /api/worktrees/adopt {"repo":"api","worktreePath":".../api/.worktrees/feat-z", …}` —
   Fleet's "Start session here". Response has **no** `attachable` field; `session.repos = ['api']`,
   `session.feature = 'feat-z'`.
3. `POST /api/sessions/<id>/servers/start` → `{"ok":true,"started":1,"total":1,"skipped":[],"failures":[]}`.
4. `lsof`: only `api`'s server is up. `web/.worktrees/feat-z` was never launched and is not
   mentioned anywhere.

`attachableWorktrees()` — written specifically for this gap, with a long comment explaining it —
is wired to exactly one route. This is the same class of lie `start-report.ts` was created to
eliminate, one scope out.

**Fix.** Compute `attachable` in `state.ts`'s `sessionState()` so every session carries it on
every frame (a cheap set lookup over the already-built scan), and have
`/sessions/:id/servers/start` fold un-owned feature members into `skipped` with reason
`'not attached to this session'`.

**Acceptance:** an adopted single-repo session in a two-repo feature reports the second repo as
skipped.

---

## Track D — Small, cheap, and clearly wrong

### BUG-19 — Five session routes answer HTTP 200 `{ok:false}` with no error, and `rename` blames the title for a missing session
**Severity: low · Effort: trivial · Confidence: reproduced (independently by two reviewers)**

Files: `server/sessions.ts:993-995`, `:1029-1031`, `:1049-1052`, `:1092-1098`, `:1101-1103`,
`:1113-1115`; `server/server.ts:476-478`, `:552-565`, `:612-626`

```
POST   /api/sessions/nope/select-tab {"tab":5}  -> 200 {"ok":false}
DELETE /api/sessions/nope                        -> 200 {"ok":false}
POST   /api/sessions/nope/rename {"title":"x"}   -> 200 {"ok":false,"error":"invalid title"}
```

`selectTab`, `closeTab`, `close`, `deactivate` and `activate` all open with
`const s = this.get(id); if (!s) return { ok: false };` — no error field, unlike their siblings
`addTab` and `renameTab`, which return `{ok:false, error:'no such session'}` on the same line.
`rename` (`:1094`) collapses two unrelated conditions into one message:
`if (!s || !title?.trim()) return { ok: false, error: 'invalid title' };`. The title `"x"` is
perfectly valid; the reported reason is a lie about the request rather than the truth about the
session. Meanwhile `/promote`, `/tabs` and `/commits` in the same file correctly answer
`no such session` (some with 400, some 404).

Also: `closeTab` checks the one-tab guard **before** the tab lookup (`:1032` before `:1033`), so
a bogus tab id on a single-tab session answers "can't close the only tab" rather than "no such tab".

**Fix.** Add `error: 'no such session'` to all five early returns; split `rename`'s condition;
reorder `closeTab`'s two checks; and map the sentinel to a status with a two-line helper
(`const send = (res, out) => res.status(out.error === 'no such session' ? 404 : out.ok ? 200 : 400).json(out)`)
applied across the session route block. Pairs with LANG-01.

---

### BUG-20 — `POST /servers/start` and `/servers/stop` answer a zero-length 200 body for unusable arguments, and bypass the deps gate
**Severity: low · Effort: trivial · Confidence: reproduced**

Files: `server/server.ts:769-784`, `server/servers.ts:777-781`

`POST /api/v1/servers/start {}` → HTTP 200, `Content-Length: 0`, no body. Same for
`/servers/stop {}`. `res.json(out.results[0])` where `results` is empty serializes `undefined`,
which express@5 sends as an empty 200 — any client doing `await r.json()` gets a parse error
instead of the real message. Every neighbouring route (`/worktrees`, `/worktrees/install-deps`,
`/worktrees/adopt`, `/sessions/:id/servers/start`) validates and 400s.

This route also skips the `canStart`/depsMissing gate that `/sessions/:id/servers/start` applies,
and does not route through `startReport` — see STYLE-05, which is the same fix.

**Fix.** Validate `repo` and `worktreePath` with a 400; guard the `results[0]` read; route
through `startReport.report(out.results)`.

---

### BUG-21 — `DELETE /api/worktrees` does not validate `worktreePath`, so the string `"undefined"` reaches a git argv
**Severity: low · Effort: trivial · Confidence: reproduced**

File: `server/server.ts:746-753`

`DELETE /api/worktrees {"repo":"beta"}` → 200
`{"ok":false,"error":"fatal: 'undefined' is not a working tree"}`. The handler validates `repo`
and passes `worktreePath` straight to `worktree.remove()`. Its three siblings all guard
(`if (!worktreePath) return res.status(400)…`). Harmless in effect — the argv discipline is real
and holds — but it is a missing guard in a family where every neighbour has one, and the 200
status misreports a failure.

**Fix.** Add the guard; return `res.status(out.ok ? 200 : 400).json(out)`.

---

### BUG-22 — `POST /api/open` with an unknown editor name silently opens the default editor and reports success
**Severity: low · Effort: trivial · Confidence: reproduced**

Files: `server/server.ts:932-954`, `server/orchestrator.ts:260-280`

`POST /api/open {"path":"/tmp","editor":"NoSuchEditor"}` → 200 `{"ok":true,"opened":1}`, and the
configured `defaultEditor` actually opened. `cfg.editors[editor] || cfg.editors[cfg.defaultEditor]`
cannot distinguish "caller did not name one" (fallback is right) from "caller named one that does
not exist" (fallback is wrong). `/group/open` has the identical expression.

**Fix.** Split the two cases in both places and 400 on an unknown name; return the resolved
editor name in the success body. Lands with STYLE-04.

---

### BUG-23 — Session title is unbounded; a 1 MB title is persisted and rides every SSE broadcast
**Severity: low · Effort: trivial · Confidence: reproduced**

Files: `server/sessions.ts:1092-1098`, `server/sessions.ts:1012-1021`, `server/server.ts:476-478`

A 1 000 000-character title → 200 `{"ok":true}`, `sessions.json` grows to 1 002 901 bytes, and
the title rides every `session-state` frame — which `bus.schedule()` fires on every Claude hook,
i.e. once per agent tool call. (An 8 MB+ body is correctly refused with 413, so the express limit
is the only ceiling.) Directly adjacent, `renameTab()` does
`String(title || '').trim().slice(0, 40)` — the convention exists in the same file.

**Fix.** `s.title = title.trim().slice(0, 200);`. Same treatment for `featureLinks` pins
(`POST /api/features/:name/links` grew `config.json` to 3.9 MB with 50 000 pins).

---

### BUG-24 — Studio's own `.worktrees/` dirties the main checkout, so every promote after the first needs a confirm — and nothing gitignores it
**Severity: low · Effort: small · Confidence: reproduced (independently by two reviewers)**

Files: `server/worktree.ts:257-264`, `server/server.ts:506-510`, `server/checkout.ts`,
`docs/config.md`, `MANUAL.md:457`

In a repo that does not gitignore `.worktrees/`:
1. First promote → 200 `ok:true` with
   `"warnings": [".worktrees/ is not gitignored here; checkouts will show as untracked"]`.
2. Second promote in the same repo →
   `{"ok":false,"needsConfirm":true,"dirty":[".worktrees/"],"ahead":{…}}` — the only dirty path
   is the directory Studio itself created a moment earlier.

So a "your working tree has uncommitted changes, carry them along?" prompt whose entire content
is Studio's own artifact, on every subsequent promote — which trains the user to click through
it. Meanwhile `docs/config.md` and `MANUAL.md:457` both state the nested container dir "must be
gitignored", and Studio is the thing that creates it. Every `git status` and `git add -A` in that
repo now carries an untracked directory containing entire other checkouts.

**Fix.** Filter the layout's own `ignorePath` out of the dirty list before deciding
`needsConfirm`. And make the first-promote warning actionable: offer to append `.worktrees/` to
`.git/info/exclude` (repo-local, uncommitted, invisible to teammates) rather than only reporting
the problem.

---

### BUG-25 — `validateConcurrency` only checks port collisions **within** one repo, never across the repos of a feature
**Severity: low · Effort: trivial · Confidence: reproduced**

File: `server/config.ts:130-160`

With `offsetStep: 100`, `backend {PORT:4000}`, `frontend {PORT:4100}`, the daemon boots with no
warning. At runtime feature A at slot 1 puts backend on 4100, colliding with feature B at slot 0
whose frontend is on 4100. The runtime side is honest — the second start answered
`{"ok":false, failures:[{"repo":"backend","error":"port 4100 already in use (pid 50053)"}]}` and
released the slot cleanly — so this is purely about catching it at boot.

`config.ts:145-159` loops `for (const [repo, rc] of Object.entries(c.repos))` and compares only
`Object.values(rc?.portEnv || {})` against each other. Bases belonging to different repos are
never compared, even though every repo in a feature is offset by the same slot index, which is
exactly what makes cross-repo bases collide.

**Fix.** Flatten all `(repo, portEnv value)` pairs across `c.repos` into one list before the
pairwise loop, and name both repos in the warning.

---

### BUG-26 — `tracked` is the one path map not realpath-normalized, so a caller-supplied spelling creates a duplicate record and skips the process-group kill
**Severity: low · Effort: trivial · Confidence: observed**

Files: `server/servers.ts:829`, `:923`, `:963` (raw key) vs `:595`, `:705`, `:860` (realpath)

On macOS with a repo under a symlinked path (`/tmp` → `/private/tmp`): start via `/group/start`
(tracked keys use the scan's resolved spelling), then `POST /api/servers/restart` with the
unresolved spelling → `servers.json` holds **two** records for one worktree (observed directly).
A subsequent `stop()` with the other spelling misses `t`, so state is `'gone'` and the
`process.kill(-t.pid)` **process-group** kill is skipped — only the single lsof-found listener
pid is signalled, leaving the `bash -lc` / `npm` parent chain alive for a real dev-server command.
`pruneTracked()` self-heals the stale record on the next `refreshRunning()`, so the missed
group-kill is the real consequence.

**Fix.** Normalize once at the top of `start()`/`stop()`/`restart()`/`logs()`:
`worktreePath = realpath(worktreePath)`, and migrate existing keys on load.

---

### BUG-27 — `/group/restart` never checks `conflictsFor`, so restarting in a non-slotted repo hard-fails on "port already in use"
**Severity: low · Effort: small · Confidence: inferred (not run)**

Files: `server/orchestrator.ts:226-258` vs `server/orchestrator.ts:180-196`, `server/servers.ts:796-799`

Give a repo a `config.start` entry but **no** `concurrency.repos` entry (so `isSlotted()` is
false and `conflictsFor()` would return its other running worktree). Run that repo's dev server
in worktree A, then `/group/restart` the feature owning worktree B: `start()`'s port pre-check
finds A holding the port and returns `{ok:false, error:'port <p> already in use (pid …)'}`, with
no `needsConfirm`/`stopConflicts` option — whereas `/group/start` would have offered to stop A.

**Fix.** Factor `/group/start`'s conflicts block into a helper and call it from `/group/restart`
with the same `needsConfirm`/`stopConflicts` contract.

---

### BUG-28 — `/group/restart` allocates slots one member at a time and 409s mid-loop
**Severity: low · Effort: small · Confidence: inferred (not isolated)**

Files: `server/orchestrator.ts:235-238` vs `server/servers.ts:891-900` (`startAll`)

`startAll()`'s own comment states the rule: *"ALL slots are allocated before ANY launch … a
caller's 409 then describes a state it has partly created."* `/group/restart` pre-allocates in a
loop and bails on the first error, keeping whatever it already allocated. `reconcileSlots()`
reclaims the orphan within one refresh cycle, so this is a transient starvation window rather
than a permanent leak — but it is exactly the hazard `startAll` was factored out to eliminate,
left un-fixed in the third verb.

**Fix.** Add `Servers.restartAll(targets)` mirroring `startAll()` and call it from `/group/restart`.

---

### BUG-29 — `/group/open` reports one aggregate ok/error for the whole feature
**Severity: low · Effort: small · Confidence: reproduced**

Files: `server/orchestrator.ts:260-280`, `server/util.ts:273-285` (`openEditor`)

With all three members succeeding: `{"ok":true}` (verified against an echo-based editor).
With one failing, `openEditor` returns `{ok:false, error: <first failure's first stderr line>}`
and the route 500s with that single string — even though most windows did open, and the caller
cannot tell which repo failed. WebStorm (no `openGroup`) loops one command per repo, so N is the
common case.

**Fix.** Have `openEditor` return per-command results and have `/group/open` answer
`{ok: every, results: [{path, ok, error}]}`.

---

### BUG-35 — `bin/wt-studio.ts` is not executable, but every session's system prompt tells the agent to run it as a bare command
**Severity: medium · Effort: trivial · Confidence: observed**

Files: `server/sessions.ts:414-415`, `bin/wt-studio.ts`, `test/sessions.test.ts:337-357`

Every session launch includes
`--append-system-prompt "…run: /path/to/worktree-studio/bin/wt-studio.ts add-repo <repo-name> …"`.
`git ls-files -s bin/` → `100644 … bin/wt-studio.ts` (while `build-client.ts` beside it is
`100755`). `test -x bin/wt-studio.ts` → not executable. The file has a `#!/usr/bin/env node`
shebang but its mode was never set in git.

This is the documented multi-repo path (MANUAL §3 and README both present `add-repo` as *the*
way a session pulls in a second repo), so the failure lands inside a live session where the user
has to diagnose it. The regression test added for the previous version of this bug asserts
`fs.existsSync(found[1])` — existence only — so it passes on a file nobody can execute.

**Fix.** `git update-index --chmod=+x bin/wt-studio.ts` (and `bin/fix-pty.ts`, also 644).
Strengthen the test to `fs.accessSync(found[1], fs.constants.X_OK)`. Alternatively make the
prompt say `node <path> add-repo …`, which works regardless of mode.

---

### BUG-37 — The install-deps log filename omits the repo, so both repos of a feature write to one file
**Severity: low · Effort: trivial · Confidence: reproduced**

Files: `server/servers.ts:646`, `MANUAL.md:598`

`install__${path.basename(worktreePath)}.log` — the worktree basename is the *feature* name, not
the repo. A feature spanning `api` and `web` produces `api__health-ep.log`, `web__health-ep.log`
(correct, per MANUAL:598) and a single shared `install__health-ep.log`. Two installs interleave;
when one repo's install fails, the log you open may be the other repo's. Additionally
`Servers.logs()` only ever reads `tracked[path].log` (the dev-server log), so the install log is
**not readable through the API at all** — which is exactly what you want after a failed install.

**Fix.** `install__<repo>__<feature>.log`, and let `/api/servers/logs` serve it.

---

### BUG-39 — The launchd agent's environment omits `SHELL` and `~/.local/bin`
**Severity: low · Effort: trivial · Confidence: inferred (could not run `./install.sh --autostart` — it writes a real launchd agent and would collide with the live daemon)**

Files: `install.sh:41`, `install.sh:47`, `launchd/com.worktree-studio.plist.template:26-36`,
`server/multiplexer/tmux.ts:137-141`

The generated plist's `EnvironmentVariables` contains `PATH` and `LANG` only; `AGENT_PATH` is
`dirname(node):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`. Then
`tmux.ts:138` runs `exec ${process.env.SHELL || '/bin/bash'} -l`. Under launchd `SHELL` is unset,
so every Studio pane runs `/bin/bash -l` instead of the user's shell. For a zsh user (the macOS
default) that sources `/etc/profile` and a `~/.bash_profile` they probably do not have, so
`~/.local/bin` never joins PATH — and Claude Code's official native installer puts `claude` at
`~/.local/bin/claude`, which is in neither the agent PATH nor a bash login shell's. Result:
sessions that launch a pane and fail with `claude: command not found`, under the install path
the README recommends. Users with an npm-global `claude` are fine (dirname(node) covers nvm).

Separately, `install.sh:41` reads `STATE_DIR` from `$WT_STUDIO_STATE` at install time but the
plist never passes it to the agent, so a user with that variable exported gets a log path
pointing at their custom dir while the daemon writes state to the default one.

**Fix.** Capture `SHELL` alongside `LANG`; add `$HOME/.local/bin` and `$HOME/bin` to
`AGENT_PATH`; pass `WT_STUDIO_STATE` through when set. Cheap belt-and-braces: have `server.ts`
check `claude.cmd` resolves at boot and log one line naming it if not.

---

## Refuted — do not act on these

**Nothing in this review was refuted.** The adversarial pass examined the eleven
highest-severity functional claims and confirmed nine outright. Recording that explicitly is
the point of this section: do not re-litigate the confirmed items, and do not re-raise the
corrected ones in their original form.

### Corrected by the adversarial pass (act on the corrected version only)

| Item | What was wrong in the original write-up | The corrected version |
|---|---|---|
| **BUG-04** | "reconcileSlots runs every ~3 s" | `watch.ts:50-51` sets `runningActiveMs: 8000` / `runningIdleMs: 120000`; the "3 s" figure survives only in a stale comment at `server.ts:130-133`. This *strengthens* the bug: every start route calls `refreshRunning()` (→ `reconcileSlots`) on the way out, so the slot is reclaimed **synchronously within the same request**. Also: `releaseSlotIfIdle` has a second, independent defect — it never checks `_starting` at all. |
| **BUG-12** | Reported as high, justified on detached HEAD | Demoted to **medium**. The exact repro needs a missing `origin/HEAD` **and** a detached *main* checkout — narrow. Justify the fix on the common case instead: `rev-parse --abbrev-ref HEAD` returns whatever branch the main checkout is on, so a main checkout parked on `feat/x` silently becomes the review baseline and promote base. Same one-line fix, in two places. |
| **BUG-09** | Reported as high; "the stack start refuses" implied `servers.start()` refuses | Demoted to **medium** (a zero-dependency repo with a dev server is rare; Yarn PnP is the real case). And patch the right layer: the refusal is in `start-report.ts:74`'s `canStart` filter, not in `servers.start()`, which has no deps check at all. The ungated `POST /api/v1/servers/start` exists server-side but has **no client caller**, so it is a fix hook, not a workaround. |
| **First-run dead end** (tracked as `ONBOARD-01` in the design doc) | Reported as high | Demoted to **medium** — an onboarding dead end with no data loss and a working remedy (Settings → baseDirs) that is merely unnamed. Still the best value-per-unit-work item in its track. |

### Duplicate — one defect, one fix

"One HTTP request kills the daemon: `Servers.start()` spawns without an `'error'` listener" and
"A dev-server start into a missing worktree directory kills the whole daemon" are the **same
defect**, reported from `/servers/start` and from `/group/start` respectively by two reviewers
working independently. They are merged here as **BUG-01**. One `child.once('error', …)` plus an
`existsSync` precheck plus moving the `this.tracked[…]` write closes both entry points. Do not
budget for two.

### Claims deliberately left as inferred — verify before acting

- **BUG-33** (`has()` PATH mismatch): the code divergence is verified; the user-visible failure
  is inferred. The shipped plist template mitigates it by injecting the installing shell's PATH,
  so this bites a daemon started some other way.
- **BUG-36** (tmux fallback), **BUG-27**, **BUG-28**, **BUG-39**: reasoned from source, never run.
- The claim that **⌘N cannot be intercepted by a page in Chrome or Safari** (see `UX-23` in the
  design doc) is inferred. Verify in the target browser before re-binding anything.
