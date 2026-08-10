# 01 — Code style, duplication and dead code

Every style/duplication finding from the August 2026 review, deduped across four reviewers.
Line numbers are against commit `5ce2f4c`; re-grep the quoted code if a line is off by a few.

**Honest volume warning: this track has 60 items.** Thirty-nine of them are trivial or small.
They are not padding — every one is a verified duplicate or a dead symbol — but nobody should
plan to land them as a single change. The ordering within each section is deliberate: earlier
items create the shared home that later items move into.

A note on tone before the list. Several reviewers independently observed that this codebase's
comments are load-bearing and mostly accurate: they cite real bugs, and files like
`start-report.ts`, `servers.startAll`, `releaseSlotIfIdle` and `identity.ts` are visible evidence
of previous de-duplication passes that worked. The problems below are the places that discipline
has **not yet reached**, plus a handful of copies that have already drifted into disagreement.

Findings marked **(found N×)** were discovered independently by that many reviewers from
different angles. That is a signal of importance, not of redundancy.

---

## §1 — Fix these first: they unblock, or they are already wrong

### STYLE-02 — `npm run lint` fails with four dead-code errors, one on the SSE hot path
**Severity: high · Effort: trivial · Verified**

`npx biome lint server/` reports four `correctness` **errors** (`biome.json` sets
`noUnusedVariables` and `noUnusedImports` to `"error"`, and `npm run check` = lint + typecheck):

- `server/state.ts:270` — `const hit = active.get(paths.resolve(r.worktreePath));` is never read.
  It is the leftover of the hand-picked list the comment at `:271-283` describes replacing with
  `...servers.decorate(...)`. It is **not free**: `sessionState()` runs on every Claude hook, and
  this does a cached-realpath resolve plus a Map lookup per owned repo per broadcast, for nothing.
- `server/server.ts:35` — `EditorConfig`, `GroupConfig`, `RunConfig`, `StartConfig` imported and
  never referenced (grep confirms line 35 is the only occurrence of each).
- `server/server.ts:840` — `sessionId` destructured out of the `/run-configs/run` body and never
  used; a stale hint of the tmux-tab implementation the comment at `:871-878` says was replaced
  by `runner.ts`.
- `server/orchestrator.ts:16` — `run` imported from `util.ts` and never called.

The repo's own quality gate is red, so `npm run check` cannot gate anything until it is green.
`state.ts:270` is also a reader trap — someone will assume `hit` is needed and reintroduce the
hand-picked list the surrounding comment exists to prevent.

**Fix.** Delete `state.ts:270`. Trim `server.ts:35` to `import type { Session, SessionRepo } from './types.ts'`.
Drop `sessionId` from the destructure at `server.ts:840`. Drop `run` from `orchestrator.ts:16`.
Do **not** silence these with `// biome-ignore`.
**Acceptance:** `npx biome lint server/` reports zero errors. (The remaining
`useOptionalChain`/`noTemplateCurlyInString` items are warnings — fix or leave deliberately, but
get the error count to 0 so the gate means something.)

---

### STYLE-12 — Three drifted implementations of "the repo's default branch", plus two route-level copies
**Severity: high · Effort: medium · Verified · (found 2×) · Pairs with BUG-12**

`server/git.ts:109`, `server/worktree.ts:209`, `server/checkout.ts:70`, `server/server.ts:631`,
`server/routes-review.ts:90`

The same `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` lookup is written three
times, and the three disagree on both prefix and fallback:

| Site | Strips `origin/` | Fallback |
|---|---|---|
| `git.ts:109 defaultBranch()` | yes | `rev-parse --abbrev-ref HEAD`, then literal `'main'` |
| `worktree.ts:209 defaultBase()` | **no** (deliberate — it wants `origin/develop` as a start point) | same two |
| `checkout.ts:70 defaultBranchOf()` | yes | **none** — returns `''`, which `prepareForSession` reads as "this repo has no default branch" |

So for a repo with no `origin/HEAD`, `git.ts` reports the current branch (or `main`) and
`checkout.ts` reports nothing — two answers to one question, in one process, about one repo.
On top of that, `server.ts:631` and `routes-review.ts:90` are two more independent
`defaultBranchOf` helpers resolving from the scan cache with a hardcoded `|| 'main'` floor, each
with a comment explaining that it matches the other one.

`review.base()` computes the review baseline from whatever default branch it is handed. Today the
two answers reach different code paths so nothing visibly breaks; the moment a fourth caller
picks the "wrong" one it silently shows the wrong diff.

**Fix.** One resolver in `server/git.ts`, exported in the two forms callers need:

```ts
/** `origin/<default>` as git spells it, or '' when there is no origin/HEAD. */
export async function originHead(repoPath: string): Promise<string>
/** The default branch NAME, with fallbacks: origin/HEAD → current branch → 'main'. */
export async function defaultBranch(repoPath: string): Promise<string>
```

`worktree.defaultBase` becomes `(await originHead(p)) || (await currentBranch(p)) || 'main'` and
disappears as a separate function. `checkout.defaultBranchOf` becomes
`originHead(p).replace(/^origin\//, '')` — keep its no-fallback semantics (`''` is meaningful
there) but express it as a documented one-liner over the shared primitive. Hoist the scan-cache
lookup from `server.ts:631` / `routes-review.ts:90` into a single exported helper so the
`|| 'main'` floor is stated once. **Do this in the same change as BUG-12** so the `'HEAD'`
sentinel guard lands once, not three times.

---

### STYLE-13 — `review.ts` reads working-tree diffs without the canonicalizing flags `hunks.ts` uses
**Severity: high · Effort: small · Verified · This is a correctness bug — tracked as BUG-38**

`server/review.ts:209`, `server/review.ts:273/281/289`, `server/hunks.ts:49`, `server/hunks.ts:77`

`review.workingFileDiff()` and `hunks.unstagedDiff()` are the same function; only `hunks.ts`
passes `DIFF_FLAGS = ['--no-color','--no-ext-diff','--src-prefix=a/','--dst-prefix=b/','-U3']`.
Full reasoning and repro in `02-functionality.md` under **BUG-38**.

**Fix.** `review.ts` imports `unstagedDiff` (already exported) and deletes its private copy; add
`...DIFF_FLAGS` to `commitDetail`'s `git show` invocations. This is also the item that makes
`DIFF_FLAGS`'s export honest — see STYLE-24.

---

### STYLE-26 — `Runner.logs()` re-implements `Servers.logs()` and has drifted
**Severity: high · Effort: small · Verified · This is a correctness bug — tracked as BUG-31**

`server/runner.ts:236-263`, `server/runner.ts:30`, `server/servers.ts:999-1023`,
`server/servers.ts:197-229`

Two implementations of one incremental byte-offset log-tail contract, differing in rotation
handling, line-boundary trimming and the `skipped` field. `TAIL_MAX_BYTES` is declared twice and
`readRange` is re-inlined. Full detail in `02-functionality.md` under **BUG-31**.

**Fix.** Extract `server/logtail.ts` exporting `readRange`, `readTail`, `tail(file, {offset, lines})`
and `TAIL_MAX_BYTES`, with `tail()` owning the whole rule. Both `Servers.logs` and `Runner.logs`
delegate. Land this before STYLE-29 (the client's two copies of the same poller), since the
client's `skipped` handling depends on the server emitting it from both routes.

---

### STYLE-15 — The Homebrew PATH prelude is copy-pasted into six modules
**Severity: medium · Effort: trivial · Verified · (found 2×) · Pairs with BUG-33**

`server/forge.ts:35`, `server/runner.ts:24`, `server/servers.ts:167`,
`server/multiplexer/tmux.ts:128`, `server/sources/github.ts:5`, `server/sources/gitlab.ts:6`

Six files independently declare, verified byte-identical:

```ts
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
```

Nothing imports it from anywhere; `util.ts`, which owns `run()` and every other shell-out
primitive, does not define it. This is the environment **every** child process inherits, and it
encodes a platform assumption. Adding a path — `/opt/local/bin` for MacPorts, a pnpm or asdf shim
dir, `$HOME/.local/bin` for a Linux user — means finding all six or shipping a fix that works for
dev servers but not for `gh`, or for `gh` but not for tmux. That is the shape of a bug report
reading "Studio can't find my CLI, except when it can".

**Fix.**

```ts
/** The PATH children get: homebrew prefixes ahead of whatever the daemon inherited.
 *  launchd starts us with a minimal PATH, so a CLI installed by brew is invisible without this. */
export const CHILD_ENV: NodeJS.ProcessEnv = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };
```

in `server/util.ts` beside `run()`. All six import it; `forge.ts`'s `cliEnv()` spreads `CHILD_ENV`
instead of a local `ENV`. **Then make `has()` probe under it too** — that is BUG-33, and it is
the whole reason this item is worth more than tidiness.

---

## §2 — Server: duplicated rules with a visible drift risk

### STYLE-01 — `sessions.ts` spells the "launch claude into a mux session" ritual four times, and the copies have drifted
**Severity: high · Effort: medium · Verified**

`server/sessions.ts:597-608` (`create`), `:694-704` (`_doAdopt`), `:1127-1176` (`activate`),
`:1288-1325` (`restore`)

`create()` and `_doAdopt()` are byte-identical apart from the cwd:

```ts
this._writeHookSettings(session);
this.sessions.set(id, session);
this._shareMemories(session);
const cmd = this.claudeCmd(session);
const r = await this.mux.ensure(muxName, { cwd: <repoPath|worktreePath>, cmd, env: { WT_STUDIO_SESSION: id } });
if (r.error) { session.state = 'stopped'; session.activity = `failed to start: ${r.error}`; }
else await this._syncTabs(session);
this._touch(id);
return session;
```

`activate()` and `restore()` repeat a resume-flavoured version: `_writeHookSettings` →
`_shareMemories` → `claudeCmd({resume})` → the identical cwd fallback
(`let cwd = s.home || s.repoPath; if (!cwd || !fs.existsSync(cwd)) cwd = s.repoPath;` at `:1134-1135`
and `:1294-1295`) → `mux.ensure` with the same env → record `agentTabId` → error-or-idle →
the identical `s.activity = s.claudeSessionId ? 'resumed' : 'restarted'` (`:1172`, `:1322`) →
`_anchorInWorktree(...).catch(()=>{})`.

**They have already drifted in three ways.**
1. **`agentTabId`.** `activate` writes `if (r.created && r.id) s.agentTabId = r.id` (`:1145`) — a
   created session with no id keeps the OLD window id — while `restore` writes
   `if (r.created) s.agentTabId = r.id ?? null` (`:1299`), which nulls it. The comment at
   `:1297-1298` says carrying the old id forward is **exactly** what made a restored session
   report "agent exited" against a live agent. `activate` still does it.
2. `restore()` has no `relaunchAgent` fallback. That is defensible (it only reaches the launch
   after `hasSession()` returned false) but nothing says so.
3. The literal `failed to start: ${r.error}` appears four times; `'worktree missing'` twice
   (`:1122`, `:1286`).

The file's own comments at `:1153-1160` and `:1303-1312` record that two of these copies were
fixed only *after* they had shipped the bug independently.

**Fix.** One private method:

```ts
async _launch(s: Session, { cwd, resume }: { cwd: string; resume?: boolean }):
  Promise<{ ok: boolean; error?: string; created?: boolean; id?: string }>
```

doing `_writeHookSettings` → `_shareMemories` → `claudeCmd(s, {resume})` → `mux.ensure(...)` →
record `agentTabId` with **one** rule (pick `restore`'s `if (r.created) s.agentTabId = r.id ?? null`,
and add a test pinning it) → on error set state/activity from a single `failedToStart(err)` helper.
Add `_resumeCwd(s)` for the existsSync fallback. `create()`/`_doAdopt()` build their Session
literal then call `_launch(session, { cwd })` followed by `if (ok) await this._syncTabs(session)`;
`activate()` keeps only its relaunchAgent/adopted branch; `restore()` keeps only its tab reset and
log line. Also factor the two Session literals (`:563-596` and `:654-693`, differing in ~8 fields)
into a `newSession(partial)` builder so an added `Session` field cannot land on one path only.

---

### STYLE-03 — `/group/:name/commits` and `/sessions/:id/commits` are two copies of the same 25-line rollup
**Severity: high · Effort: small · Verified · (found 2×)**

`server/server.ts:645-669` and `server/server.ts:671-696`

Both handlers build the identical response from the identical calls — per repo,
`const def = defaultBranchOf(...); const { base, commits } = await review.commits(path, def); const wc = await review.working(path);`
— then the same three-line reduce:

```ts
uncommitted: {
  fileCount: wc.files.length,
  added: wc.files.reduce((n, f) => n + (f.added || 0), 0),
  deleted: wc.files.reduce((n, f) => n + (f.deleted || 0), 0),
}
```

and push `{ repo, worktreePath, branch, base, defaultBranch, commits, uncommitted }`. The only
differences are the member source (`g.members` with `m.path` vs `s.repos` with `entry.worktreePath`)
and the guard. Both are live: `dock/FeaturePane.svelte:62` calls the group form and
`dock/Dock.svelte:71` the session form, and the comment at `server.ts:637-644` says the whole
point is "same shape, so the client renders both the same way" — which nothing enforces.

Add a field (staged counts, say) to one and the feature pane and the session dock silently
disagree. This is the payload **three** surfaces render: ReviewPanel, FeaturePane, and the Dock's
✎ badge.

**Fix.** `async function commitsRollup(targets: Array<{repo, worktreePath, branch}>)` in
`server/review.ts` next to `working()` (or in a new `server/routes-commits.ts`), plus a
`review.workingSummary(worktreePath)` returning `{fileCount, added, deleted}` so the reduce exists
once. Both routes become: resolve the target list, `res.json(await commitsRollup(list))`.
While there: both handlers `await` **serially** over repos, so a two-repo feature pays two
sequential `git log` round-trips; `Promise.all` is a free win and keeps them behaving alike.
Declare the return type as `RepoCommits` in `server/types.ts` so STYLE-30 can import it.

---

### STYLE-04 — The editor open-command builder exists twice, and the copies behave differently for a single path
**Severity: medium · Effort: small · Verified · (found 2×) · Pairs with BUG-22**

`server/server.ts:932-954` (`POST /open`) and `server/orchestrator.ts:260-280` (`POST /group/open`)

Both resolve `cfg.editors[editor] || cfg.editors[cfg.defaultEditor]`, 400 when absent, split/join
the `{path}`/`{paths}` template around `shq()`-quoted paths (both carrying the same four-line
comment about why split/join and not `replace()`), then `openEditor(cmds)` and 500 on failure.

Four verified divergences:
- **openGroup threshold.** `server.ts:947`: `list.length > 1 && ed.openGroup`.
  `orchestrator.ts:274`: `ed.openGroup ? … : …`. A one-member feature opened via `/group/open`
  runs the `openGroup` template; the same worktree via `/open` runs the plain `open` template.
- **Dedup.** `/open` builds `[...new Set(...)]` (`:938-942`) with the comment "a caller that
  passed the same path twice must not open two windows on it"; `/group/open` does not — and
  `resolveGroup` can return two members whose `path` resolves to the same directory in a manual group.
- **Empty-path filtering.** `/open` filters non-strings/empties; `/group/open` does not.
- **Key coercion.** `orchestrator.ts:267` uses `cfg.editors[String(editor)]` with a comment
  explaining why; `server.ts:934` uses the unchecked body value.

Both routes are reached by the *same button* in different states (ActionBar's "Open in editor"
calls `/open` for a session and `/group/open` for a sessionless feature — `ops.svelte.ts:412` and
`:552`). So opening the same one-repo feature can invoke two different editor templates depending
on whether an agent happens to be running.

**Fix.** Move it next to `openEditor` and `shq` in `server/util.ts`:

```ts
export function editorCommands(ed: { open: string; openGroup?: string }, paths: unknown[]): string[] {
  const list = [...new Set(paths.filter((p): p is string => typeof p === 'string' && !!p))];
  if (!list.length) return [];
  return list.length > 1 && ed.openGroup
    ? [ed.openGroup.split('{paths}').join(list.map(shq).join(' '))]
    : list.map((p) => ed.open.split('{path}').join(shq(p)));
}
```

plus `pickEditor(cfg, name)`. Pick the `length > 1` threshold deliberately (it keeps single-path
behaviour identical across both routes and is what WebStorm-style editors have always received)
and say so in the comment, which then exists once. Both routes reduce to
pickEditor → 400 → `editorCommands` → `openEditor` → 500/200. Fix BUG-22 (unknown editor name)
in the same change.

---

### STYLE-05 — `POST /servers/start` is the one launch route that still bypasses `start-report.ts`
**Severity: medium · Effort: small · Verified · Pairs with BUG-20**

`server/server.ts:769-776`, `server/servers.ts:826-867`, `server/start-report.ts:1-20`

`servers.start()` deliberately returns `{ ok: true, listening: false }` for a process that spawned
and never bound a port (`servers.ts:840-867`; the `StartResult` doc at `:116-145` says explicitly
that collapsing "unverified" into "listening" is what let a stack report success for a server that
never came up). `start-report.ts` exists to turn that into a failure, and `/group/start` and
`/sessions/:id/servers/start` both route through `startReport.report(...)`.

`/servers/start` does not: it answers `res.json(out.results[0])` — the raw `StartResult`. The
caller receives `{ok:true}` for a dev server that is not listening, with `listening:false` sitting
unread next to it. That route is what `alfred/src/action.sh:68` and `swiftbar/wts-action.sh:46`
call — the two surfaces least able to show a nuanced result. `start-report.ts`'s own header names
the two routes that had this bug; the third one still has it.

Smaller sibling drift: `/sessions/:id/servers/start` returns `{ ...startReport.report(...), results: out.results }`
(`server.ts:596`) while `/group/start` returns `startReport.report(...)` alone
(`orchestrator.ts:209`) — same nominal contract, different payload.

**Fix.** `res.json(startReport.report(out.results))`, or at minimum map `listening === false` to
`ok: false` with `startReport`'s `notListening(r)` message (currently module-private at
`start-report.ts:133` — export it). Align the two batch routes on one payload. Update
`docs/api.md:700-706` in the same commit (STYLE-10).

---

### STYLE-07 — `server.ts` open-codes the slot-release and refresh-then-broadcast rituals that `orchestrator.ts` already has a helper for
**Severity: medium · Effort: small · Verified**

`server/server.ts:598-610`, `:612-626`, `:777-785`; `server/orchestrator.ts:168-171`

`orchestrator.ts` defines `releaseIdleSlots(members)` precisely because the stop-then-release
sequence needs a fixed order, and uses it in `/group/stop` and `/group/close`. `server.ts` never
got the helper and spells the loop out instead — identically at `:607` and `:622`:

```ts
for (const r of owned) servers.releaseSlotIfIdle(servers.featureFor(r.worktreePath), runningCache);
```

plus a single-target variant at `:782`. The ordering rule — `refreshRunning()` **before** the
release, because the guard reads what is still listening — is restated in prose at `server.ts:604-606`,
`:621` and `orchestrator.ts:217-219`: three copies of one invariant with nothing enforcing it.
The adjacent `await refreshRunning(); broadcastTopology();` pair appears **eight** times in
`server.ts` alone (`:594-596`, `:606-608`, `:621-623`, `:764-766`, `:773-774`, `:780-783`,
`:792-793`, `:866-867`).

`servers.ts:368-385` documents that three routes previously freed slots three different ways and
that the wrong one leaked ports to the next feature. The shared `releaseSlotIfIdle` fixed the
*rule*; the **order** around it is still a convention held by comments.

**Fix.** One local helper owning both halves:

```ts
const afterMutation = async (paths: string[] = []) => {
  await refreshRunning();
  for (const p of paths) servers.releaseSlotIfIdle(servers.featureFor(p), runningCache);
  broadcastTopology();
};
```

Replace all three `server.ts` sites and both `orchestrator.ts` sites; delete
`orchestrator.releaseIdleSlots`. That collapses the eight refresh+broadcast pairs to one call each
and makes the ordering unstateable-in-prose because it is inside the helper.

---

### STYLE-27 — Session-scoped review routes resolve `:id` + `repo` two different ways, in two modules
**Severity: medium · Effort: medium · Verified**

`server/routes-review.ts:51` (`resolveWorktree`), `server/server.ts:698-729`

`routes-review.ts:51` has one place that turns a session id plus an optional repo name into a
promoted worktree, with a documented convenience: "With one repo the name is redundant — don't
make callers pass it." Three routes in `server.ts` re-derive it inline and disagree:

- `server.ts:701` (`/sessions/:id/commit-detail`): `(s.repos || []).find(r => r.repo === qs(req.query.repo))`
  — **no single-repo fallback**, so on a one-repo session `GET /sessions/:id/commit-detail?sha=…`
  (no `repo`) 400s where `GET /sessions/:id/diff?sha=…` succeeds. Error text is
  `'unknown repo or no worktree'` vs routes-review's `` `unknown repo '${repoName}'` `` / `'repo is required'`.
- `server.ts:714` (`POST /sessions/:id/commit`): a missing session answers **400**;
  `routes-review.ts:53` and `server.ts:700` both answer **404** for the same condition.

`/diff` and `/commit-detail` are near-synonyms served by different modules with different
resolution rules, so the same client request shape works against one and fails against the other.

**Fix.** `resolveWorktree` is already exported (`routes-review.ts:150`). Use it in `server.ts` for
`/sessions/:id/commit-detail` and `/sessions/:id/commit`, adopting its 404/400 split and its
single-repo fallback; delete the inline `find`s at `server.ts:701` and `:715`.

---

### STYLE-06 — Five micro-helpers are each defined two or three times across modules that already import from each other
**Severity: medium · Effort: small · Verified · (found 3×)**

1. **`isRecord`** — `server/server.ts:53-55` and `server/settings.ts:28-30` are byte-identical
   including the docstring (`!!v && typeof v === 'object' && !Array.isArray(v)`), and
   `server/config.ts:170-172` is the same body under the name `isJsonObject` with a different type
   predicate. `server.ts:23` already imports four other symbols from `settings.ts`, and
   `settings.ts` already **exports** `isRecord`. It is a validation predicate used on request
   bodies — two copies is two places to change if "plain object" ever needs refining.
2. **Query-param collapsing** — `server.ts:44-47` (`qs`), `transcript-routes.ts:202-208`
   (`one`/`str`), a third open-coded copy at `server.ts:972-973` for the hook receiver, and an
   inline form at `routes-review.ts:107`. All carry the same explanatory comment about `?a=1&a=2`
   producing an array. `type QueryValue = Request['query'][string]` is also declared twice
   (`server.ts:43`, `transcript-routes.ts:42`). **The inline form is subtly different:**
   `String(req.query.sha ?? '')` on an array `['a','b']` yields `"a,b"` rather than `"a"`. Today
   `isValidSha` rejects it so it produces a 400 — but the same pattern on a field with no validator
   behind it silently passes a comma-joined string into a git argv.
3. **`defaultBranchOf`** — `server.ts:631-632` and `routes-review.ts:70-77`. See STYLE-12.
4. **The "session repo that has been promoted" type + predicate** — `server.ts:62-63`
   (`PromotedRepo` + `promoted`), `routes-review.ts:25-26` + `:55` (its own `PromotedRepo` plus an
   inline `(r): r is PromotedRepo => !!r.worktreePath`), and `state.ts:261` (inline
   `(r): r is typeof r & { worktreePath: string }`). Adding a field to `SessionRepo` means
   touching three predicates.
5. **`msg(e)`** — `server.ts:50` defines `e instanceof Error ? e.message : String(e)`;
   `sessions.ts:948` open-codes it; `sessions.ts:1327` and `servers.ts:669` use the **unsafe**
   `(e as Error).message` variant, as do five other modules.

**Fix.** Put `isRecord`, `queryString(v, fallback?)` + the `QueryValue` type, and `errMessage(e)`
in `util.ts` (already the home for shared micro-helpers) and import them everywhere; delete
`settings.ts`'s and `config.ts`'s copies (`isRecord` narrows to the same thing `isJsonObject`
does). Keep `transcript-routes.ts`'s overload signature (`str(v, 'default'): string` vs
`str(v): string|null`) — it is genuinely useful and should be the shared shape. Export
`PromotedRepo` and `promoted` from `types.ts` and use them in all three call sites.

---

### STYLE-09 — `promote()`'s git plumbing lives inside `SessionManager` and hand-rolls git instead of using `util.git`
**Severity: low · Effort: medium · Verified**

`server/sessions.ts:709-720` (`_dirtyMain`), `:735-779` (`_aheadOfBase`), `:793-838`
(`_moveDirtyInto`), `:840-963` (`promote`)

~130 lines of pure git plumbing on the `SessionManager` class. `_dirtyMain` and `_aheadOfBase`
touch no instance state at all (verified: they reference only `run` and their arguments);
`_moveDirtyInto` touches only `this._dirtyMain`. With `promote()` (124 lines doing five jobs:
confirm-gate, worktree create, dirty replay, session mutation, `pendingRepos` fan-out) that is
about 350 of `sessions.ts`'s 1339 lines — a third of the file a reader opens to understand the
session lifecycle is git mechanics.

Separately, all three hand-roll `run('git', ['-C', repoPath, ...])` even though `util.ts` exports
`git(cwd, args)` and `gitFull(cwd, args, opts)` for exactly this. `sessions.ts` imports `run`
(line 7) and never `git`, so these calls do not inherit whatever `util.git` grows (a timeout
policy change, say) and the two spellings will diverge silently because no test asserts they agree.

**Fix.** `server/promote.ts` exporting `dirtyMain(repoPath)`, `aheadOfBase(repoPath)` and
`moveDirtyInto(repoPath, worktreePath)` as free functions (they already are, in everything but
syntax), reusing `gitFull` so exit codes stay readable. **Keep every existing comment verbatim** —
the `--cherry-pick --right-only` reasoning at `:752-763` and the nested-layout refusal at
`:800-807` are both load-bearing. Optionally split `promote()` further into `_confirmGate(s, opts)`
and `_fanOutPendingRepos(id, s)`.

---

### STYLE-32 — `addRepo` duplicates `attachRepo`'s body on its happy path while delegating to it on the error path
**Severity: low · Effort: trivial · Verified**

`server/sessions.ts:475-516`, `:522-536`

`addRepo` already calls `attachRepo` when the worktree turns out to exist (`:487-503`). On the
success path it inlines what `attachRepo` does: push a `repos` entry (`:505-512`) and
`await this.sendWhenReady(s.muxName, '/add-dir ' + res.path, s)` then `_touch` (`:514-516`) — the
same three steps as `:527-536`. The copies differ in one field: `addRepo` writes
`worktree: res.name`, `attachRepo` writes `worktree: wtname ?? null`. `addRepo` also skips
`attachRepo`'s duplicate-**path** guard (`:525`) and guards on repo **name** instead (`:478`), so a
session that already owns a different worktree at the same path via a rename gets a second entry.

**Fix.** Have `addRepo`'s success path call `attachRepo` too. Decide whether the path-based guard
should also apply to `addRepo` — it should; the repo-name guard is a weaker test of the same condition.

---

### STYLE-14 — `working()` and `commitDetail()` carry two byte-identical copies of the numstat + name-status merge
**Severity: medium · Effort: small · Verified**

`server/review.ts:174-194` and `server/review.ts:264-286`

Both open with the same `byPath` map and `get()` closure, then run the same two merge loops,
differing only in the argv (`['diff','--numstat','-z','HEAD']` vs `['show','--format=','--numstat','-z',sha,'--']`).
The long comment above `parseNumstatZ` (`:99-109`) documents a real bug this merge prevents — a
rename producing a phantom `old => new` entry that renders as an empty file block and reads to the
user as though their changes vanished. That rule now lives in two places.

**Fix.** `async function mergeChangedFiles(cwd, numstatArgs, nameStatusArgs): Promise<ReviewFile[]>`;
`working()` appends its `??` untracked pass afterwards. ~40 lines become ~20. Move the
`parseNumstatZ`/`parseNameStatusZ` comment block onto the new helper, since that is what it explains.

---

### STYLE-17 — Two versions of the Claude-projects directory, reading two different env vars
**Severity: medium · Effort: small · Verified**

`server/transcripts.ts:97` + `:109`, `server/claude-memory.ts:36` + `:48`

Both modules independently locate `~/.claude/projects` and independently implement Claude Code's
path-slugging convention, and they disagree on the override:

```ts
// transcripts.ts:97
opts?.root || process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')
// claude-memory.ts:36
process.env.WT_STUDIO_CLAUDE_PROJECTS || path.join(HOME, '.claude', 'projects')
```

The slug functions are equivalent (`A-Za-z0-9` vs `a-zA-Z0-9`); the roots are not. Setting one env
var moves the transcript index but leaves memory linking pointed at the real directory — a
half-redirected state no test catches, because each module's tests set its own var. Both files
carry a long comment explaining the **same** convention, derived by inspection, and both note that
if Claude Code changes it the feature silently stops working — so when it changes, the fix has to
land in two files that don't reference each other, and whichever is missed fails silently *by design*.

**Fix.** One owner (`server/claude-paths.ts` or `util.ts`) exporting `CLAUDE_PROJECTS_DIR`
(accepting both env vars during a deprecation window) and `claudeProjectSlug(absPath)`. Make the
two modules' existing names thin re-exports so tests keep passing, then remove the aliases. Move
the "verified 12/12 against a real ~/.claude/projects" comment to the shared function; delete the
duplicate. Neither env var appears in `MANUAL.md` — document whichever you keep.

---

### STYLE-16 — POSIX shell-quoting written three times, once inline inside a template literal
**Severity: medium · Effort: trivial · Verified**

`server/util.ts:235` (`shq`, canonical), `server/run-configs.ts:117` (`const q`, one-letter name,
no comment), `server/multiplexer/tmux.ts:197` (inlined: `` `. '${file.replace(/'/g, `'\\''`)}'` ``)

All three are the same algorithm. `run-configs.ts` does not import `util.ts` at all, which is why
the copy exists. Shell quoting is a **security primitive** here — `run-configs.ts` produces
command lines that `runner.ts` hands to `bash -lc`, built from paths and arguments read out of the
user's editor config files. Three implementations means three places to audit and three places a
future fix has to land. The one-letter `q` gives a reader no signal that it is the same
security-relevant function.

**Fix.** Delete `run-configs.ts`'s `q` and import `shq` (or `const q = shq` locally if the brevity
is wanted at its ~8 call sites). Replace `tmux.ts:197`'s inline form with `` `. ${shq(file)}` `` —
same output, and the `.`-not-`source` comment stays. Add a test asserting all callers round-trip a
path containing a single quote.

---

### STYLE-18 — `AttachSpec` declared three times, and the copies disagree about `env`
**Severity: medium · Effort: trivial · Verified**

`server/multiplexer/tmux.ts:13` (producer, `env` **required**), `server/term.ts:51` (consumer,
`env?` optional), `server/sessions.ts:110` (`MuxAttachSpec`)

`term.ts:641` relies on the optionality: `env: { LANG: 'en_US.UTF-8', ...(spec.env || process.env) }`.
That `|| process.env` is **unreachable** against the only real producer (tmux always sets `env`),
so it is untested code standing in for a case that cannot happen — while a *test double* built
against `term.ts`'s optional type is allowed to omit `env`, which is the shape the real driver
forbids. The type the doubles are checked against is laxer than the contract, which is backwards.

**Fix.** Declare it once in `multiplexer/tmux.ts` (or `multiplexer/types.ts`); `term.ts` and
`sessions.ts` `import type` it. `tmux.ts:64-68`'s argument for narrower consumer-side shapes
applies to *method sets*, not to a 3-field data record with no narrower useful form. Once `env` is
required, drop the dead `|| process.env` (keep the LANG-first comment — it explains the spread
order, which stays).

---

### STYLE-19 — `unref` copied verbatim into a second module
**Severity: medium · Effort: trivial · Verified**

`server/ci.ts:56` and `server/watch.ts:140` are byte-identical:
`function unref<T extends { unref?: () => unknown }>(t: T): T { if (t && typeof t.unref === 'function') t.unref(); return t; }`

**Fix.** Move to `server/util.ts` (a timer/handle utility with no domain content) and import in both.

---

### STYLE-21 — Query-string coercion solved three times, in three styles
**Severity: low · Effort: small · Verified**

`server/server.ts:44`, `server/transcript-routes.ts:202`, `server/routes-review.ts:107`.
Merged into **STYLE-06 item 2** — fix them together.

---

### STYLE-22 — `createForge()` is a provider registry, a cache, a PR opener and an express route table in one closure
**Severity: low · Effort: medium · Verified**

`server/forge.ts:336-493`, with `register` at `:432`

`createForge()` returns `{ register, ciForRepo, openPullRequest, invalidate, installed }`. Four of
those are the forge domain; `register` mounts `GET /sessions/:id/ci` and `POST /group/pr` and
therefore drags express `Router`, `SessionLookup` and `ResolveGroup` into a module whose job is
talking to `gh`/`glab`. It carries a **second dependency-injection channel just for the routes**:
`register(app, deps)` re-resolves `manager` and `resolveGroup` from either its own args or the
closure (`:437-438`, with a `!` non-null assertion on each). The codebase already has the pattern
— `routes-review.ts` and `transcript-routes.ts` are exactly "routes for module X, registered from
server.ts".

**Fix.** `server/routes-forge.ts` exporting `register(api, { forge, manager, resolveGroup, onChanged })`
with the two handlers moved verbatim, comments included (the `String(x ?? '')` note and the
`every()`-not-`some()` note are both load-bearing). `createForge` keeps
`{ ciForRepo, openPullRequest, invalidate, installed }` and loses `register`, the `Router` import
and the two types; the `!` assertions and their "a route reached without one is a wiring bug"
comment both disappear. `server.ts:907` becomes `routesForge.register(api, {...})`. **One wiring
detail to get right:** the `invalidate()` + `onChanged()` call after a successful PR
(`forge.ts:472-479`) moves with the route and needs `forge.invalidate` passed in.

---

### STYLE-23 — `populate()` re-implements `copyMatches()` inline for its second loop
**Severity: low · Effort: trivial · Verified**

`server/worktree.ts:148-162` (`copyMatches`) and `:176-190` (`populate`)

`populate()` uses the helper for the `always` patterns and then, twenty lines later, open-codes the
same expand/mkdir/copyFileSync/count sequence for the `patterns` list — the only real difference
being the `isIgnored()` check and an `existsSync`/`isFile` guard. The two loops handle failure
differently: `copyMatches` mkdirs before the try and copies unconditionally; the inline loop stats
the source first, so a file that exists but is unreadable is counted differently by each.

This is the code that carries a user's gitignored `.env` and local config into a new worktree.
That failure mode is **silent** by nature — two copy paths means two places for a silent failure to hide.

**Fix.** Give `copyMatches` an optional predicate
(`copyMatches(repoPath, dest, pattern, shouldCopy?: (rel: string) => Promise<boolean>)`), make it
async, and call it from both loops. The `existsSync`/`isFile` guard becomes part of the shared body
(correct for both cases). ~15 lines net removal, one definition of "what counts as copied".

---

### STYLE-25 — `checkout.ts` declares a local `git` that shadows `util.ts`'s `git` with a different return type
**Severity: low · Effort: trivial · Verified**

`server/checkout.ts:67`, `server/util.ts:63`

`util.ts` splits deliberately: `git()` returns trimmed stdout as a string (`''` on failure),
`gitFull()` returns the whole `RunResult`. `checkout.ts` imports neither and defines
`const git = async (repoPath, args) => run('git', ['-C', repoPath, ...args]);` — which is
`gitFull` under the name `git`. Every call site then reads `.stdout.trim()` or `.code` off it
(`:72`, `:83`, `:91`, `:137`, `:147`), which is a type error everywhere else in the codebase.

Reader tax in a 178-line file of careful "never lose work" logic — and it blocks STYLE-12, since
sharing a default-branch resolver across `git.ts`/`worktree.ts`/`checkout.ts` is awkward while one
of them has a private `git` with different semantics.

**Fix.** Delete `checkout.ts:67`, import `gitFull`, rename the ~6 call sites (bodies unchanged —
they already read `RunResult` fields). The fetch at `:104` with its custom timeout becomes
`gitFull(repoPath, ['fetch','--prune','origin'], { timeout })`.

---

### STYLE-11 — `state.ts` has two near-identical member type-guards 150 lines apart
**Severity: low · Effort: trivial · Verified**

`server/state.ts:161-163` (`hasSession`) and `:317-319` (`present`)

`hasSession(m)` is `!!m && !m.missing && !!m.session`; `present(m)` is `!!m && !m.missing`. Both
carry the same two-line comment ("A manual group can name a worktree that has since been removed,
and those arrive as `{ missing, ref }` stubs") in slightly different words.

**Fix.** Define `present` once near the top and write
`hasSession = (m: FeatureMember): m is Worktree & { session: EmbeddedSession } => present(m) && !!m.session`.
Better: export `present` from `features.ts`, where the `{ missing, ref }` stub shape is created,
so the guard sits next to the thing it guards against.

---

### STYLE-24 — Ten exports that nothing outside their own file imports, not even a test
**Severity: low · Effort: trivial · Verified**

Grepped `server/`, `client/src/`, `bin/`, `test/`:
`worktree.ts:322` (`populate`), `worktree.ts:325` (`expandPattern`), `diff.ts:384`
(`formatHunkHeader`), `diff.ts:386` (`splitLines`), `security.ts:231` (`LOOPBACK`),
`transcript-index.ts:675` (`sqliteAvailable`), `transcripts.ts:584` (`toEntry`),
`features.ts:128` (`isLinked`), `hunks.ts:181` (`DIFF_FLAGS`), `git.ts:156` (`describeRepo`).

For contrast, these DO have test consumers and must stay exported: `alignRows`, `stripPrefix`,
`normalizeSelection`, `parseWorktrees`, `isLinkedWorktree`, `ghChecks`, `glChecks`, `providerFor`,
`labelFor`, `parseJsonc`, `unstagedDiff`, `stagedDiff`, `resolveRef`, `STRATEGIES`, `likePattern`,
`TIMEOUTS`, `PLACEHOLDER`, `CONNECTION_ERROR_CODES`.

An export is a claim that something is part of a module's contract, so each is a thing a reader
must consider before changing behaviour. `DIFF_FLAGS` is the pointed case: it *looks* shared, and
per STYLE-13 it **should** be — but today nothing imports it, so the appearance of sharing is
doing the opposite of its job.

**Fix.** Drop these from their export lists (keep them as private functions). **Two exceptions:**
keep `DIFF_FLAGS` exported once `review.ts` imports it (STYLE-13), and keep `expandPattern` if
`copyMatches` gains a caller (STYLE-23). Before removing, run
`grep -rn '<name>' bin/ alfred/ swiftbar/ hooks/` — `bin/` and `hooks/` were checked and are
clean, `alfred/` and `swiftbar/` were not.

---

### STYLE-20 — Dead ternary in `transcripts.toEntry`: both branches are the same expression
**Severity: low · Effort: trivial · Verified**

`server/transcripts.ts:373` — `let text = type === 'user' ? contentText(msg.content) : contentText(msg.content);`

At this point `type` is already narrowed to `'assistant' | 'user'` by the guard on line 371, and
both arms read `msg.content` the same way. It *reads* as though user and assistant content are
extracted differently — that is what a ternary on `type` asserts — so a reader looks for the
difference, does not find one, and either leaves it or guesses.

**Fix.** Replace with `let text = contentText(msg.content);`. **Check `git log -L 373,373:server/transcripts.ts`
first** — if it was ever asymmetric, the missing arm may be a real behaviour regression worth
restoring rather than a typo worth deleting.

---

### STYLE-31 — The priced usage rollup is written twice: once over transcript entries, once over SQL rows
**Severity: low · Effort: small · Verified**

`server/transcripts.ts:487-504` (`aggregate`) and `server/transcript-index.ts:626-660` (`summarize`)

Both end with the same pricing rollup: iterate accumulators, `pricing.costOf(model, u, {speed})`,
accumulate `costUsd` when `priced`, add to `unpriced` when `!priced && pricing.isBillable(model)`,
push `{...u, costUsd: pricing.round(usd), priced}` onto `byModel`, sort with the identical
comparator `(b.costUsd || 0) - (a.costUsd || 0) || b.output - a.output`. The shared primitives
(`blankTotals`, `addUsage`) were already extracted and `summarize` imports them from `transcripts`
— so the dependency edge exists; only the pricing loop stayed forked. They agree today except that
`aggregate()` tracks `allPriced` → `complete`, which `summarize()` does not expose.

These two feed the same UI panels by different routes, so a change to how an unpriced model is
attributed, or to the `byModel` ordering, applied to one copy makes the same session report
differently depending on which path served it — with nothing on the panel indicating which. The
`'unknown'` model-name normalisation already needed a comment at `transcript-index.ts:637-639`
explaining it was made to match `aggregate()`; that is the tell.

**Fix.** Export `priceAccums(accums): { byModel, costUsd, unpricedModels, complete }` from
`server/pricing.ts` (the only module that should know the pricing→reporting mapping). `summarize()`
gains `complete` for free, which the fleet view currently cannot show for indexed sessions.

---

### STYLE-08 — `server.ts` is five route modules plus a bootstrap, in a codebase that already has a `register(api, deps)` convention
**Severity: medium · Effort: large · Verified · Do this LAST — see the "do NOT" list in the README**

`server/server.ts:283-438` (settings + feature colour/links), `:448-626` (sessions CRUD/tabs/servers),
`:634-727` (commits + commit-detail + commit), `:729-887` (worktrees + dev servers + run configs +
runs), `:890-957` (adopt + editor open)

Four modules already follow the pattern — `orchestrator.register(api, deps)` (`:890`),
`forge.register(api)` (`:907`), `transcriptRoutes.register(api, {...})` (`:956`),
`routesReview.register(api, {...})` (`:957`) — each with a header explaining why (self-contained
route table, testable against a fake, `server.ts` never touched again). `server.ts` nonetheless
hosts five more coherent route groups inline. The bootstrap itself — mux/identity/manager/servers/
runner, the scan cache, `refreshRunning`, the SSE bus, express, WS upgrade, boot sequence — is well
under 300 lines and is genuinely one thing.

The file is 1099 lines whose top half you scroll past to reach the boot sequence, and the inline
routes are precisely the ones that duplicated the group routes (commits, open, start) — because a
module boundary is what makes you look for the existing implementation before writing a new one.

**Fix.** Extract one at a time, cheapest first, each a standalone commit:
(a) `routes-commits.ts` taking the shared rollup from STYLE-03;
(b) `routes-servers.ts` (dev servers, install-deps, run-configs, runs) taking `{ cfg, servers, runner, afterMutation }`;
(c) `routes-settings.ts` taking `{ cfg, save, rescan, broadcastTopology }`;
(d) `routes-sessions.ts`.
Type each deps object by the surface it uses, as `orchestrator.ts:20-136` does. Leave `server.ts`
as bootstrap + wiring + the `/hook` receiver (which genuinely belongs outside `/api`) — target ~300 lines.

---

### STYLE-10 — `docs/api.md` describes two behaviours the code deliberately changed
**Severity: low · Effort: trivial · Verified**

`docs/api.md:246`, `docs/api.md:471`, `docs/api.md:702`; `server/servers.ts:712-728`, `server/server.ts:596`

- `api.md:246` says `canStart` is "The repo has a `start` command configured, so `/servers/start`
  can launch it." `servers.ts:712-715` says the opposite, in a comment written specifically to
  record the change: "`canStart` used to mean 'a start command is configured', so it stayed true
  for a worktree that could not possibly start… so it now means that" — it is `configured && !deps`.
  The doc is the old definition. The sibling fields `decorate()` returns (`depsMissing`,
  `depsInstalling`, `noStartCmd`) are not documented at all.
- `api.md:471` says `POST /sessions/:id/servers/start` returns `{ ok, results: [...] }` where `ok`
  is true if **any** started. That `some()` semantics is the exact bug `start-report.ts:1-20` was
  written to kill; the route now returns `{ ok, started, total, skipped, failures }` where `ok`
  requires zero failures AND zero skipped. A client author reading this row will write `if (r.ok)`
  expecting "something came up" — or write a `some()`-style check against a payload that no longer
  has `results` in the group form.
- `api.md:702` shows `GET /servers/logs` returning `{ offset, text, size }`; `servers.ts:999-1023`
  returns `{ offset, text, size, skipped }`.

`state.ts:1-12` presents `docs/api.md` as the contract other clients build against.

**Fix.** Rewrite the `canStart` row ("Starting this worktree will work: a `start` command is
configured AND its dependencies are installed") and add rows for `depsMissing`, `depsInstalling`,
`noStartCmd` pointing at `skipReason()`. Replace the `/sessions/:id/servers/start` row with the
`StartReport` shape and cross-reference `server/start-report.ts`. Add `skipped` to the
`/servers/logs` row. **Do this in the same commit as STYLE-05** so the three start routes and their
docs land aligned.

---

## §3 — Client: `lib/` stores, ops, api layer

### STYLE-34 — `errMessage` is the stated rule, is not exported, and 18 sites reimplement it or use the cast it forbids
**Severity: high · Effort: small · Verified · (found 3×)**

`client/src/lib/ops.svelte.ts:22-29` defines `errMessage(e: unknown)` with a comment saying
explicitly: *"One helper rather than a cast per site — a cast would claim the thrown value is an
Error, which nothing guarantees."* It is declared **without `export`**. Consequently:

- **Seven sites re-inline** `e instanceof Error ? e.message : String(e)`:
  `RunConfigMenu.svelte:63`, `:96`; `insights/UsagePanel.svelte:56`; `insights/SessionUsage.svelte:37`;
  `insights/SearchPanel.svelte:91` (named `errText`); `dock/RunsPanel.svelte:91`, `:101`, `:109`;
  `dock/FeaturePane.svelte:64`.
- **Eight sites do exactly what the comment forbids** — `(e as Error).message`:
  `SettingsModal.svelte:100`, `:158`; `IntakeModal.svelte:64`, `:93`; `review/ReviewPanel.svelte:105`,
  `:133`, `:150`, `:172`. `ReviewPanel:172` builds a **user-visible banner** from that cast, which
  renders the literal string `undefined` if the daemon ever rejects with a non-Error.
- **It has already drifted.** `SessionUsage.svelte:37` wraps the expression in an AbortError guard
  that none of the others have:
  `.catch((e) => { if (!(e instanceof Error && e.name === 'AbortError')) error = e instanceof Error ? e.message : String(e); })`.
  `UsagePanel.svelte:56` and `SearchPanel.svelte:91` **also use abort signals and lack the guard**,
  so a cancelled request there can flash a spurious error. Live drift, today.

**Fix.** Move `errMessage` (with its comment) into `$lib/api.ts` — which every one of those files
already imports — and export it. Add a sibling `isAbort(e: unknown): boolean` there. Replace all
fifteen inline copies and casts; delete `SearchPanel`'s `errText`. Then audit the three
abort-signal call sites so they all use the same `if (isAbort(e)) return;` guard.
**Pick api.ts, not ops.svelte.ts** — do not export from both.

---

### STYLE-33 — `ops.svelte.ts` repeats the same try/catch/toast envelope 24 times
**Severity: high · Effort: medium · Verified**

`grep -c 'catch (e) {' client/src/lib/ops.svelte.ts` returns 24, at lines 139, 162, 195, 205, 213,
230, 245, 279, 348, 366, 375, 396, 421, 470, 522, 533, 546, 555, 566, 607, 630, 649, 659. Every one
is byte-identical:

```ts
} catch (e) {
  toast(errMessage(e), true);
}
```

The module's own header states the convention it is manually re-implementing at each site: *"an op
never throws. It reports through `toast(msg, true)` and returns."* Several ops are nothing **but**
the envelope — `renameTab` (`:210-216`), `activateSession` (`:372-379`), `openGroup` (`:552-558`),
`stopMainServer` (`:655-662`) are each one `api()` call, one toast, and four lines of boilerplate.
That is roughly 100 of the file's 669 lines. The header also says duplicating "confirm then POST
then toast" per call site "is how the two copies drift apart" — and the file then does exactly that
24 times.

There is no single place to add a behaviour every op should have (suppressing the toast on an
AbortError, say, or logging failures), so adding one means 24 edits and any miss is silent. It also
buries the ~8 ops that have real logic (`promote`, `editSession`, `runStack`) inside 16 that have none.

**Fix.**

```ts
async function op<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch (e) { toast(errMessage(e), true); }
}
```

Trivial ops become one-liners; ops that already wrap in `pending.run` compose
(`pending.run(name, () => op(async () => { … }))`); `promote`, `editSession`, `editFeature`,
`runStack`, `deleteFeature` keep their bodies inside `op(async () => …)`. **Do not change
observable behaviour** — callers ignore the return value at every `.svelte` call site checked.

---

### STYLE-35 — The rail's `s:`/`f:`/`w:` key scheme is written independently in four places
**Severity: high · Effort: medium · Verified**

`client/src/lib/stores/ui.svelte.ts:74` (`selectionKey`), `:296`, `:306`, `:316` (`railRows`
re-spelling the literals inline), `client/src/lib/deeplink.ts:43` (`hashForSelection`, a third
spelling with `encodeURIComponent`), `deeplink.ts:34` (`selectionFromHash`, the inverse).

The deeplink header even asserts the coupling — "The fragment reuses the rail's own key scheme …
instead of inventing a second vocabulary" — but the reuse is by convention, not by code.

`goToNextWaiting` (`ui.svelte.ts:543`) and `railDigits` both match a `RailRow`'s `key` against
`selectionKey(this.selection)`. If a fourth selection kind is added, or a prefix letter changes,
the row keys and the selection keys silently stop matching: the rail highlights nothing and
⌥-digit selection points at the wrong row, **with no compile error anywhere**.

**Fix.** Make `selectionKey` the single encoder and export it:
`export function selectionKey(s: Selection, enc: (v: string) => string = (v) => v): string`.
Then (a) `railRows` builds keys by calling it — consider storing `sel: Selection` on the row and
deriving `key` from it; (b) `hashForSelection` becomes `s ? '#' + selectionKey(s, encodeURIComponent) : ''`;
(c) `selectionFromHash` keeps its own parse but drives it from one shared
`const PREFIX = { session: 's', feature: 'f', mainserver: 'w' } as const` so the letters exist once.

---

### STYLE-42 — Dialog results are read back by hard-coded positional index in three places
**Severity: medium · Effort: medium · Verified**

`client/src/lib/ops.svelte.ts:259-282` (`editSession`), `:337-351` (`editFeature`), `:89-92` (`promote`)

`uiDialog` returns `DialogValue[]` in declaration order, so every caller does index arithmetic
coupled to a field list built elsewhere. `editSession` builds `[Name, Colour, ...linksFields(feature)]`
and reads `out[0..3]`; `editFeature` builds `[Colour, ...linksFields(feature)]` and reads
`out[0..2]` — the same three values shifted by one. `promote` maintains a manual cursor because two
of its fields are conditional: `let i = 0; const bringChanges = dirty ? choice[i++] === true : false;`.

`linksFields` returning two fields is an invisible contract enforced only by two magic offsets in
two functions. Adding a third field to `linksFields` — entirely plausible, it is where feature
metadata accretes — silently makes `editSession` write the links array into the ticket slot and
vice versa. **No type error, and probably no runtime error**, because `saveLinks` string-coerces
everything: it would just write garbage to disk. This is the highest-consequence fragility in the area.

**Fix (preferred).** Give `DialogField` an optional `name?: string` and have `dialogs.open` resolve
to `Record<string, DialogValue>` when every field is named (keeping the array form for unnamed
specs). `editSession` reads `out.title`/`out.color`/`out.ticket`/`out.pins`; `promote` reads
`out.bringChanges`/`out.bringCommits` with no cursor at all.
**Fix (cheaper, if touching `DialogHost` is too wide).** Have `linksFields` return
`{ fields, read(out, offset) }` so the offset arithmetic lives once, beside the field construction.
Either way, factor the shared tail of `editSession`/`editFeature` — colour-compare,
`setFeatureColor`, `saveLinks`, `toast('Saved')` — into one `saveFeatureEdits(feature, color, ticket, pins)`.

---

### STYLE-36 — Five client exports with zero callers anywhere in the repo
**Severity: medium · Effort: trivial · Verified**

Grepped every `.ts` and `.svelte` under `client/src`:

- `ui.appView` (`stores/ui.svelte.ts:411`) — 1 hit, its own declaration.
- `ui.serverFeatures` (`:242`) — 1 hit, its own declaration.
- `ui.nothingSelected` (`:397`) — 1 hit. Its docstring claims "the dock shows its empty state",
  which the dock does not consult.
- `busy()` (`api.ts:118`) — exported with a 4-line docstring; zero callers.
- `openEditor()` (`ops.svelte.ts:393`) — zero `.svelte` callers; the only other hits are a prose
  comment and a string literal in `ActionBar.test.ts:24`'s mock list.
- `showPrResults()` (`ops.svelte.ts:582`) — exported, only caller is `prFeature` in the same file.
- `tokenQuery(sep)` (`api.ts:35`) — the `'&'` branch is dead; the single caller
  (`world.svelte.ts:263`) always passes `'?'`. Its docstring says "for EventSource and WebSocket
  URLs", but `Terminal.svelte:129` builds its WebSocket token with `URLSearchParams`.

`nothingSelected` and `appView` are the worst: they read as the app's answers to "is anything
selected" and "is the dock in app mode", so a future change is likely to update them and expect the
UI to follow — and nothing will happen. Dead `$derived` fields also cost a recomputation on every
world frame.

**Fix.** Delete `ui.appView`, `ui.serverFeatures`, `ui.nothingSelected`, `api.busy`. Un-export
`showPrResults`. Delete `openEditor` and remove the stale `'openEditor'` entry from
`ActionBar.test.ts:24`'s mock list — **that same list also mocks `'renameSession'`, which no longer
exists in ops** (replaced by `editSession`); clean both. Collapse `tokenQuery` to a no-argument
form or inline it at its single call site.

---

### STYLE-37 — A whole family of comments cites files that no longer exist (`public/app.js`, `public/style.css`, `server/*.js`)
**Severity: medium · Effort: small · Verified**

`ls public/` fails — the directory does not exist at `5ce2f4c`. `ls server/*.js` matches nothing.
Yet these comments point readers at both:
`stores/world.svelte.ts:40`, `ops.svelte.ts:4`, `stores/ui.svelte.ts:4`, `stores/notify.svelte.ts:2`,
`stores/toasts.svelte.ts:1`, `stores/dialog.svelte.ts:2`, `api.ts:4`, `:16`, `:40`,
`actions/activatable.ts:10`, `actions/trapFocus.ts:26`, `components/review/api.ts:5`,
`components/review/model.ts:213`, `components/insights/api.ts:99`, `components/insights/format.ts:139`.

The worst is `world.svelte.ts:40`, which ends a 25-line architectural explanation by naming a
deleted file as the authority: *"This matches `lastTopology` / `lastSessions` / `stitchSessions` in
public/app.js, which is the implementation that gets it right."*

These are not decorative. Three of them (`review/model.ts` refusal text, `insights/api.ts`
`ftsTerms`, `insights/format.ts` billing multipliers) explicitly instruct a future maintainer to
keep the file in sync with a named server file — and the named file cannot be opened.

**Fix — two mechanical passes.** (1) `.js` → `.ts` for every `server/<name>.js` citation; these are
real, still-correct pointers with the wrong extension. (2) `public/app.js` / `public/style.css` /
`public/index.html` citations describe a pre-port codebase that is gone: drop the clause (e.g.
`toasts.svelte.ts:1` becomes "Transient bottom-right notices. 3.2 s, 6 s for errors.") or, where
the comment's whole point is porting provenance (`activatable.ts:10`, `trapFocus.ts:26`), rewrite
it to state the rule directly. For `world.svelte.ts:40`, delete the final sentence — the preceding
20 lines make the argument on their own merits.

---

### STYLE-38 — `billedWeight` duplicates `weightByClass`'s arithmetic; `writeMultiplier` duplicates its cacheWrite blend
**Severity: medium · Effort: trivial · Verified**

`client/src/lib/components/insights/format.ts:160`, `:178`, `:211`

Three functions, one formula, written three times. `billedWeight` is exactly
`input + cacheWrite + cacheRead` of `weightByClass`; `writeMultiplier` writes the cacheWrite blend
a third time to divide it by the raw write count. All three also repeat the `if (!u) return …` guard.

The 30-line comment above these (`:127-153`) is emphatic that the multipliers must have one source
because "they were written down twice" before and that went wrong. The multipliers now do — the
**formula that consumes them** does not. If the API adds a cache-write TTL (the comment's own
scenario), the stacked bar stops summing to the headline number, with no test or type catching it.

**Fix.** `weightByClass` becomes the only place the products are written;
`billedWeight = (u) => { const w = weightByClass(u); return w.input + w.cacheWrite + w.cacheRead; }`;
`writeMultiplier` divides `weightByClass(u).cacheWrite` by the raw write count. All three lose
their own null guard. **Verify against the existing insights tests before and after — values must
be bit-identical.**

---

### STYLE-39 — The web-app rule and the repos→worktrees flatten are each written twice
**Severity: medium · Effort: small · Verified**

`client/src/lib/stores/world.svelte.ts:323` (`webAppsFor`), `stores/ui.svelte.ts:267`
(`visibleMainServers`), `stores/ui.svelte.ts:222` (`selectedMainServer`)

"A browsable frontend" is one product rule (configured as a web repo, currently running, has a
discovered port) enforced in two files that don't import each other. `webAppsFor` has a test in
`world.test.ts`; `visibleMainServers` does not, so only one copy is pinned. Separately,
`world.repos.flatMap((r) => r.worktrees || [])` appears twice inside `UI`, both running on every
world frame.

**Fix.** One exported predicate in `world.svelte.ts`:
`export const isServable = (r: ServableRow) => webRepoSet().has(r.repo) && !!r.running && !!(r.ports||[]).length`,
called by both (`visibleMainServers` as `w.isMain && isServable(w)`). Add
`get allWorktrees(): Worktree[]` to `World` as a `$derived` so the flatten happens once per frame.

---

### STYLE-41 — Three call styles on top of one `request`, and the query-string helper exists in only one of them
**Severity: medium · Effort: small · Verified**

`client/src/lib/api.ts:109`, `components/insights/api.ts:34`, `:40` (`qs`),
`components/review/api.ts:84`, `:96`, `:109`, `:62`

`api.ts` correctly consolidated the transport (its header tells the story of the three drifted
copies), but three conventions survived on top: the `api('POST', url, body)` shorthand (42 call
sites); insights' private `get`/`post` plus a `qs()` helper that skips null/undefined/empty params;
and `review/api.ts`, which calls `request` directly and hand-builds every query string
(`` const q = `?repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(sha)}` `` at `:96` and
again at `:109`) — the exact class of thing `qs()` already solved one directory over.
`review/api.ts:62` also names its URL-builder `api`, **shadowing** the exported transport with
something that is not a request function: `request('GET', \`${api(sessionId)}/commits\`)` reads as
a nested request call.

**Fix.** Promote `qs()` into `$lib/api.ts` and export it; use it in `review/api.ts`'s
`fetchCommitDetail` and `fetchHunks`. Rename `review/api.ts`'s local `api` to `sessionUrl`.
**Leave** the `api()` shorthand and insights' `get`/`post` as they are — each earns its existence
(body-vs-opts ergonomics; pricing adoption).

---

### STYLE-30 — The branch-rollup wire shape is redeclared three times in the client instead of imported
**Severity: medium · Effort: small · Verified**

`client/src/lib/components/review/api.ts:35` (`Commit`) + `:45` (`RepoCommits`, full shape),
`dock/FeaturePane.svelte:39` (`RepoRoll`, a narrower re-description dropping `worktreePath`,
`defaultBranch` and the per-commit `added`/`deleted`/`fileCount`), `dock/Dock.svelte:72` (an inline
`(r: { uncommitted?: { fileCount?: number } })`), against `server/server.ts:654` and `:685` — two
anonymous object literals with **no server-side type at all**.

The client imports the server's types everywhere else and says why: `review/api.ts:15-19` ("The
diff shapes come from the SERVER, not a second description of them… the copies that used to live
here as @typedefs could drift from the producer"), `world.svelte.ts:51-64` ("The wire contract comes
from the SERVER'S OWN types, not a copy"). The `/commits` rollup is the exception — and it is the
shape three separate surfaces render (Changes panel, feature pane, ✎ tab badge). Renaming
`uncommitted.fileCount` or adding a field produces no error anywhere; `FeaturePane`'s narrower copy
already means a server-side addition is invisible there by default. The three also disagree on
optionality: `Dock.svelte` treats `uncommitted` as optional, the other two as required.

**Fix.** Declare `RepoCommits` once in `server/types.ts` and use it as the return type of the shared
`review.rollup()` helper from STYLE-03, so both routes are type-checked against it. `review/api.ts`
re-exports it exactly as it already re-exports `DiffFile` at `:19`; `FeaturePane.svelte` deletes
`RepoRoll`; `Dock.svelte` types its reducer parameter.

---

### STYLE-29 — The byte-offset log-tail poller is implemented twice in the client, with different follow/interval/partial-line rules
**Severity: medium · Effort: medium · Verified · Depends on STYLE-26**

`client/src/lib/components/dock/LogsPanel.svelte:43`, `dock/RunsPanel.svelte:57`, `:13`

Each owns a full copy: an `$effect` with an `alive` flag, an `offset` starting `undefined`, a
self-scheduling `setTimeout` chain (with the same "never `setInterval`, so a slow response cannot
overlap" reasoning written out twice), a near-bottom scroll check, and a `follow` toggle.
RunsPanel's header even names the source: "a byte-offset tail like LogsPanel's".

Verified differences: near-bottom threshold 60px vs 40px; poll interval 1500 ms vs 900 ms;
LogsPanel buffers the trailing partial line (`append()`, `:73-82`) and caps at `MAX_LOG_LINES = 2000`,
**RunsPanel does neither and grows `text` without bound**; LogsPanel assigns `offset`
unconditionally, RunsPanel only inside `if (res.text)` with an `else if (offset === undefined)`
catch-up. Neither reads `res.skipped`.

Nobody decided a run log should scroll-follow at a tighter threshold than a server log — it just
happened. Concretely: watching a chatty test suite grows one unbounded string, and a line split
across two polls renders as two lines, which LogsPanel's `partial` buffer explicitly prevents.

**Fix.** `createLogTail({ fetchChunk, intervalMs, shouldContinue })` in `client/src/lib/` as a
`.svelte.ts` rune module owning `$state` for `text`/`lines`/`tailing`, the alive flag, the offset,
the timeout chain, the partial-line buffer, the line cap and one near-bottom threshold. Keep the
per-panel differences (colour classification, stop-when-finished) as parameters — those are
genuinely different; the transport is not. Land after STYLE-26 so `skipped` exists on both routes.

---

### STYLE-40 — `nudge()` is duplicated with swapped parameter order, and `move()` is an identity wrapper
**Severity: medium · Effort: trivial · Verified · (found 2×)**

`client/src/lib/components/SettingsModal.svelte:171` — `function nudge<T>(list: T[], i: number, by: number)`
`client/src/lib/components/DialogHost.svelte:26` — `function nudge(i: number, rows: DialogLink[], by: number)`

Identical bodies (`return moveItem(list, i, Math.max(0, Math.min(list.length - 1, i + by)));`), but
the first two parameters are in the **opposite order** and one is non-generic. DialogHost's comment
even points at the other copy ("as SettingsModal does it"). `reorderable.ts` exists precisely to be
the shared home for list-reordering logic — its header says `moveItem` is separate from the action
"so every list in the modal moves rows the same way." The keyboard half of that job got copied instead.

Two functions with the same name, the same body and different signatures is the sharpest edge here:
a copy-paste between the two files compiles in one direction and silently produces wrong indices in
the other.

Separately, `SettingsModal.svelte:168` is
`const move = <T,>(list: T[], from: number, to: number): T[] => moveItem(list, from, to);` — a pure
identity wrapper with a six-line docblock that actually documents `moveItem` (`reorderable.ts:94`),
a property already covered by `reorderable.test.ts`.

**Fix.** Export `nudgeItem<T>(list, i, by)` from `reorderable.ts` next to `moveItem` (list-first,
matching `moveItem`'s order). Import in both; update DialogHost's two call sites for the swap.
Delete `move` and call `moveItem` at its five `use:reorderable` sites; relocate any part of its
docstring that `moveItem`'s own comment does not already say.

---

### STYLE-47 — The `missing` member guard is written four times in three shapes
**Severity: low · Effort: small · Verified**

- `ui.svelte.ts:125` — `if (!m || ('missing' in m && m.missing)) return false; const w = m as Worktree;`
- `ui.svelte.ts:144` — `(m: FeatureMember): m is Worktree => Boolean(m) && !('missing' in m && m.missing)`
- `ui.svelte.ts:235` — `Boolean(m) && !('missing' in m && m.missing) && (m as Worktree).repo === this.repoFilter`
- `world.svelte.ts:135` — `m && !('missing' in m && m.missing) ? { ...m, session: … } : m`

Only one (`:144`, `liveMembers`) is a type predicate; the other three fall back to `as Worktree`
casts precisely because the guard wasn't expressed as one. `ui.svelte.ts:235`'s comment says the
guard is there specifically to avoid "casting it away", then casts on the very next clause.

**Fix.** Export one predicate from `world.svelte.ts` (where the types live):
`export const isLive = (m: FeatureMember | null | undefined): m is Worktree => Boolean(m) && !('missing' in m! && m!.missing);`
Rewrite `liveMembers`, `featureActive`, `#featureMatches` and `stitchSessions`'s member map in terms
of it. All three casts disappear.

---

### STYLE-43 — `sortFeatures`'s ordering is computed on every frame and observed by nobody
**Severity: low · Effort: small · Verified**

`client/src/lib/stores/ui.svelte.ts:132` (`sortFeatures`), `:239` (`visibleFeatures`), `:331` (`railRows`'s comparator)

`visibleFeatures` = `sortFeatures(world.features.filter(this.#featureMatches))`. Its three consumers:
`serverFeatures` (dead — STYLE-36); `railRows`, which spreads it into a list then **re-sorts** at
`:331` by `waiting desc, active desc, name localeCompare` (a total order, so the incoming order is
discarded); and `ActionBar.svelte:46`'s order-independent `.find()`. So the active-first-then-
alphabetical sort is only ever observed by `ui.test.ts:88`'s direct test of `sortFeatures`. Note
also `featureActive` is evaluated twice per feature per frame — once inside `sortFeatures`, once at
`:318`.

The module header (`:16-22`) presents this ordering as load-bearing behaviour that "came across
with the rows and is easy to drop by accident" — while the code that actually decides rail order is
200 lines below, using a different, stricter comparator. **A reader is told to protect the wrong thing.**

**Fix.** Drop the `sortFeatures` call from `visibleFeatures` (rename it so its job — filter, not
order — is honest); delete `sortFeatures` and its test along with `serverFeatures`; update the
header's ORDERING paragraph to point at `railRows`'s comparator. Confirm `ui.test.ts`'s rail-order
assertions (`:171-190`, `:311`) still pass — they assert `railOrder`, so they should be unaffected.

---

### STYLE-44 — Guarded-localStorage is hand-rolled at five sites, and the `'usage'|'term'` collapse rule is written twice
**Severity: low · Effort: trivial · Verified**

`stores/ui.svelte.ts:102`, `:110`, `:413`, `:456`; `theme.svelte.ts:120`

Five separate `try { localStorage… } catch { /* private mode */ }` blocks. Beyond the boilerplate,
one rule is stated twice with no link:
`savedDock` (`:104`): `return localStorage.getItem(DOCK_KEY) === 'usage' ? 'usage' : 'term';`
`setDockView` (`:416`): `localStorage.setItem(DOCK_KEY, v === 'usage' ? 'usage' : 'term');`
"Only Insights is worth restoring; everything else collapses to term" is one decision as two
independent ternaries. A mismatch produces a dock that persists a value it then refuses to restore
— a bug that only shows up across a page reload.

**Fix.** `$lib/local.ts` with `readLocal(k)` / `writeLocal(k, v)`; replace all five sites. Express
the dock rule once as `const persistable = (v: DockView): DockView => (v === 'usage' ? 'usage' : 'term')`
and call it from both.

---

### STYLE-45 — `NAVIGABLE` is a five-element Set that means "not a gap"
**Severity: low · Effort: trivial · Verified**

`client/src/lib/components/review/model.ts:57`, `:177`

`const NAVIGABLE = new Set(['file','note','group','hunk','row']);` — the `Item` union (`:60-72`)
has exactly six discriminants; the Set enumerates all but `gap`, and its own comment says so
("Everything drawn is navigable"). An allowlist containing every value but one reads as a curated
policy, so a reader must cross-check it against the union to discover there isn't one. It is
unchecked against the union (`Set<string>`, so a typo would never be caught) and it makes a new
`Item` kind **non**-navigable by default and silently unreachable with ↑/↓ — whereas the inverse
form forces an explicit decision only when it shouldn't be.

**Fix.** `export const navigable = (item: Item): boolean => item.k !== 'gap';`, delete
`NAVIGABLE`, move the "a diff row is the unit a reader actually moves through" sentence onto the
one-liner. Behaviour identical for every value.

---

### STYLE-46 — Four orphaned, duplicated or tombstone doc comments
**Severity: low · Effort: trivial · Verified**

1. `stores/ui.svelte.ts:36-43` — two `/** */` blocks stacked. The first ("One ⌘1–9 target. `id` is
   null for a feature with no agent…") describes `RailEntry` but sits above `RailRow`'s own
   docblock and therefore attaches to `RailRow`. `RailEntry` (`:49`) has no doc at all.
   **The comment describes the wrong type.**
2. `ops.svelte.ts:335-336` — two consecutive one-line docblocks on `editFeature`. The first
   ("Colour a feature that has no session — the same tag, reached from the feature itself")
   predates links editing and is now wrong; the second, immediately below, is correct.
3. `components/review/api.ts:78-79` — a completely empty `/**\n */` docblock on `fetchCommits`.
   (`applyHunks` at `:120-123` has a stray trailing blank comment line too.)
4. `components/review/model.ts:261-269` — a nine-line comment explaining why a function named
   `stat()` was removed. It documents code that is not there.

Items 1 and 2 are actively wrong descriptions attached to live declarations — the class of comment
a reader trusts over the code.

**Fix.** (1) Move the ⌘1–9 block down onto `RailEntry`. (2) Delete `ops.svelte.ts:335`, keep 336.
(3) Delete the empty docblock and the stray blank line. (4) Delete the `stat()` tombstone — the
reasoning is already in the commit message, which is where it belongs.

---

## §4 — Client: `.svelte` components

### STYLE-48 — Modal chrome CSS is triplicated byte-for-byte across three modals
**Severity: high · Effort: small · Verified**

`SettingsModal.svelte:353-358`, `DialogHost.svelte:200-207` + `:237`, `IntakeModal.svelte:182-191`

`.modal-head`, `.modal-body`, `.modal-foot` and `.field` are declared identically in all three —
e.g. all three carry
`.modal-body { padding:16px; background:var(--elevated); border-top:1px solid var(--border); display:flex; flex-direction:column; gap:14px; overflow-y:auto; }`
and the same `.modal-foot`. The uppercase caption rule is a **near-miss**: SettingsModal:358 and
IntakeModal:191 both say `.field label, .field .lbl { … }` while DialogHost splits it into `.lbl`
(`:210`) and `.field label` (`:237`) with a comment explaining why — three spellings of one rule.

`Modal.svelte` already exists as the shared overlay but owns only the backdrop and panel box
(`:41-46`), so the interior chrome fell out of it. Meanwhile `app.css:118-164` already hosts exactly
this class of shared chrome (`.btn`, `.dot`, `.pill`, `.chip`, `.input`, `.spacer`), so the
convention for where this belongs is established and simply was not followed.

**Fix.** Move `.modal-head`, `.modal-body`, `.modal-foot`, `.field`, `.field label`/`.lbl`,
`.hint`/`.lbl-note` and `.foot-note` into `app.css` alongside the existing block; delete all three
local copies. Keep genuinely local rules (IntakeModal's `.srctabs`, DialogHost's `.dlg-msg`,
SettingsModal's `.setsec`). Alternative if you prefer component boundaries: give `Modal.svelte`
three optional snippet props (`head`, `body`, `foot`) — but the app.css route matches what app.css
is already for and is a smaller change.

---

### STYLE-49 — AppMenu and RunConfigMenu duplicate the entire popover dismiss effect, comment included, plus drifted `.sheet` CSS
**Severity: high · Effort: small · Verified**

`AppMenu.svelte:39-54` / `RunConfigMenu.svelte:105-121`; `AppMenu.svelte:104-127` /
`RunConfigMenu.svelte:174-195`

The dismiss-on-outside-click-and-Escape effect is character-identical in both files, down to the
rationale comment ("a permanent document listener for a menu that is almost always shut is a cost
paid on every click"):

```ts
const onDocClick = (e: MouseEvent) => { if (root && e.target instanceof Node && !root.contains(e.target)) open = false; };
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); open = false; } };
```

The `.sheet` CSS is a **drifted** copy: both share
`position:absolute; right:0; z-index:60; padding:5px; background:var(--panel); border:1px solid var(--border-strong); border-radius:10px; box-shadow:var(--shadow); display:flex; flex-direction:column;`
but differ in item padding (`8px 10px` vs `7px 9px`), gap (`10px` vs `9px`), glyph gutter width
(`26px` vs `14px`), and hover (`:hover` vs `:hover:not(:disabled)`). Two popovers in the same app
that already look subtly unlike each other.

**Fix.** Extract a `dismissable` Svelte action into `client/src/lib/actions/` (next to
`activatable.ts` / `trapFocus.ts`, which is where this app puts DOM behaviour) taking
`{ open, onclose }` and owning both document listeners plus the Escape `stopPropagation`. Use it in
both. Hoist the shared `.sheet` / `.sheet button` / `.sheet .g` rules into `app.css` with one set of
values, keeping only the two genuine differences as modifier classes: the vertical anchor and the
gutter width. **Land with UX-03** — that item changes the anchor from `bottom:` to `top:`, and
doing both at once avoids touching this CSS twice.

---

### STYLE-50 — DiffViewport builds the same stage/unstage payload six times, twice via a no-op ternary
**Severity: high · Effort: small · Verified**

`review/DiffViewport.svelte:169-172`, `:180-194` (keyboard path `applyAtCursor`), `:426`, `:431`,
`:449`, `:465` (four inline click handlers); `review/model.ts:22-26`

Group shape: `:193` `onapply({ op, file: b.file, ...selectionOf(g) })` vs `:449`
`onapply({ op: it.g.action === 'stage' ? 'stage' : 'unstage', file: it.b.file, ...selectionOf(it.g) })`
vs `:426`/`:431` spelling the same thing again with a literal op. Hunk shape: `:186`
`onapply({ op, file: it.b.file, hunks: [it.hunk.index], expect: [it.hunk.header] })` vs `:465`,
identical but for the op expression.

Separately, `it.g.action === 'stage' ? 'stage' : 'unstage'` at `:449` and `:465` is a **pure no-op**:
`model.ts:25` declares `action: 'stage' | 'unstage' | null`, and both sites are already guarded by
`{#if stageable && it.g.action}`. The whole ternary is `it.g.action`.

The button and its keyboard equivalent (`s`/`u`) are the only two ways to stage a hunk, and they
are separately-written code producing the same request against a real git index. If the payload
gains a field (a repo, a base sha) one path gets it and the other silently posts a stale shape.

**Fix.** Two builders next to `selectionOf` — `hunkOp(op, block, hunk)` and `groupOp(op, block, group)`
— each returning `{ op, file, hunks, expect }`. `applyAtCursor` and all four template handlers call
them. Replace both ternaries with plain `it.g.action`. The cursor-move side effect (`cursor = i`)
stays in the template handlers where it belongs.

---

### STYLE-52 — `Terminal.svelte` exports four props and two methods its single call site never uses
**Severity: medium · Effort: small · Verified**

`Terminal.svelte:27-49`, `:350`, `:364-368`; `dock/Dock.svelte:140`

There is exactly one `<Terminal>` in the app — `Dock.svelte:140`,
`<Terminal {sessionId} active={isTerm} revive={…} />` (the only other reference is a `vi.mock` in
`Dock.test.ts`). No component holds a `bind:this`. So the following is dead: the `tab` prop
(`:29`, plus its use at `connect()` `:126` and in the target key at `:317`), `autofocus` (`:45`),
`maxRetries` (`:47`), `onstatus` (`:48`, with five internal call sites at `:134/150/161/166/170`
that go nowhere), `export function focus()` (`:350`), and `export function sendText()` (`:364-368`,
carrying an eight-line comment about the `{type:'input'}` frame). `export function refit()` is
called internally at `:344` but the `export` keyword is unused.

This is the highest-stakes file in the client — it owns the pty socket, the retry chain and the
generation counter. Every dead branch is one more thing a reader must reason about before touching
the socket lifecycle. `sendText` reads as "something can type into this terminal", which nothing
does. The `tab` prop is worse than dead: it is woven into the retarget key at `:317`, so it looks
like multi-pane support exists.

**Fix.** **First verify** whether `?tab=` on `/ws/term` is still honoured server-side (it is
referenced in the wire-protocol comment at `:9`). If nothing drives it: delete `tab`, `autofocus`,
`maxRetries`, `onstatus` and the five `onstatus?.()` calls; simplify `:317`'s target key to
`${sessionId}\0${revive}`; delete `focus()` and `sendText()`; drop `export` from `refit`. If any is
a deliberately-kept seam, say so in one line each — right now nothing distinguishes "kept on
purpose" from "forgot to remove". ~50 lines out of the file that matters most.

---

### STYLE-51 — TabStrip's comments describe an Insights tab that no longer exists in the strip, and one comment dangles over nothing
**Severity: medium · Effort: trivial · Verified**

`dock/TabStrip.svelte:7-8`, `:259`, `:234-260`

The file-header comment says "The right group is DOM panels (Changes / Logs / Insights) — views of
the same session". The panels group renders exactly three buttons: **Changes, Logs, Runs**. Insights
is not there — it is a top-bar toggle (`TopBar.svelte:50-54`) plus `ui.dockView === 'usage'`
rendered by `Dock.svelte:84-85`. Runs, which IS there, is not named. Worse, `:259` is a comment with
**no element after it** — `<!-- Available for any session: a transcript exists before a worktree does. -->`
sits immediately before the closing `</div>`. It was the justification for a tab that has been deleted.

The header is the first thing a reader trusts, and it names the wrong set of tabs. The dangling
comment asserts a capability that no longer has any code, so a reader hunting for the
unpromoted-session escape hatch looks for something that isn't there.

**Fix.** Update `:7-8` to "(Changes / Logs / Runs)". Delete `:259`. While in there, confirm whether
the Runs tab is meant to be inside `{#if promoted}` — it currently is, and no comment explains that.

---

### STYLE-53 — FeatureCard and SessionCard duplicate the entire rail-card shell CSS under two class names
**Severity: medium · Effort: small · Verified**

`rail/FeatureCard.svelte:148-171`, `rail/SessionCard.svelte:73-92`

`.hit` is byte-identical in both
(`display:block; width:100%; min-width:0; text-align:left; background:none; border:0; padding:10px 11px 8px; cursor:pointer; color:inherit; font-family:inherit; overflow:hidden;`).
So is `.digit` and `.act`. `.fname` (FeatureCard:167) and `.title` (SessionCard:88) are the same
declaration list under **two names**. The card boxes differ only in the colour-token layer
(`.fcard` uses `var(--fc-wash, var(--panel))` and an inset `--fc` edge; `.scard` uses flat
`var(--panel)`/`var(--brand)`) but both repeat
`border:1px solid var(--border); border-radius:10px; margin:0 8px 6px; transition:border-color .12s, background .12s;`,
both repeat the `prefers-reduced-motion` override, and both repeat `:hover { border-color:var(--border-strong); }`.

Two rail rows meant to read as the same kind of object, maintained as two independent stylesheets;
a padding or radius change must be made twice and verified by eye. `.fname` vs `.title` means a
reader learns two vocabularies for one line of text.

**Fix.** Add a `.railcard` / `.railcard .hit` / `.railcard .digit` / `.railcard .cardname` /
`.railcard .act` block to `app.css` (or a tiny `RailCard.svelte` wrapper taking a snippet, if you
prefer keeping the reduced-motion rule co-located). Both cards use
`class="railcard fcard"` / `class="railcard scard"` and keep only the colour-token differences
locally. Rename `.fname`/`.title` to one name. **Land after UX-04** (which changes how selection is
drawn on `.fcard`) so this CSS is touched once.

---

### STYLE-54 — Four independent implementations of visually-hidden text, in three techniques
**Severity: medium · Effort: trivial · Verified**

- `review/DiffViewport.svelte:725` — `.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; margin:0; }`
- `insights/SearchPanel.svelte:353-356` — `.vh { … clip:rect(0 0 0 0); white-space:nowrap; border:0; }`
- `DialogHost.svelte:236` — `.vh { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }` — **different clipping technique, and it omits `white-space:nowrap`**, which is the part that stops a long label from being collapsed by the 1px box (its swatch labels at `:158`/`:164` are multi-word).
- `insights/TokenMix.svelte:207` — a fourth.

Two class names, three implementations, one behaviourally different, nothing in `app.css`.
Screen-reader-only text must be right everywhere or is worth nothing — and a reader grepping for
`sr-only` will not find `.vh` and will write a fifth copy.

**Fix.** One `.sr-only` rule in `app.css` using the `clip-path` form **plus** `white-space:nowrap`;
delete all four local copies; rename every `class="vh"` usage to `sr-only`.

---

### STYLE-55 — JSDoc type annotations shadow the real TypeScript types in 19 of 40 components, and SearchPanel's props are declared twice
**Severity: medium · Effort: medium · Verified**

Every component is `<script lang="ts">` with real annotations, yet **62** JSDoc `@param {…}` /
`@type {…}` tags survive across 19 files (DiffViewport 14, SearchPanel 8, Terminal 7, LogsPanel 5).
Pure noise where they agree — `/** @param {number} i */ function focusHit(i: number)`
(`SearchPanel:178-179`) — and a hazard where they might not: **`SearchPanel.svelte:21-30` declares
the six props as a JSDoc `@type` object literal and `:42-49` declares the same six again as a TS
annotation.** Only the TS one is checked; the JSDoc one is free to rot.

Separately, 22 sites use inline `import('./model.js').Block`-style type expressions even where the
file already has a top-level `import type` for the same module — `DiffViewport` imports `Item` at
`:2` then writes `import('./model.js').Group` at `:170` and `import('./model.js').Block` at `:294`.
`ReviewPanel.svelte:159-160` carries an empty `/**\n */` block above `apply()`. Several `$state`
declarations carry stray four-space indentation from the JS→TS port (`SearchPanel:59-74`,
`UsagePanel:26-29`, `ReviewPanel:187-189`, `SettingsModal:51-53/109/119`, `IntakeModal:26/77`,
`DiffViewport:294`).

In a codebase whose whole comment convention is "comments are load-bearing", ~60 lines of comment
the reader must verify against the signature beside it dilutes that.

**Fix.** Delete every `@param {T}` / `@type {T}` tag whose information is in the TS signature,
keeping the prose half where there is one. Delete SearchPanel's JSDoc props block (`:21-30`)
entirely. Convert the 22 inline `import('…').X` expressions to top-level `import type`. Delete the
empty docblock at `ReviewPanel:159-160`. Run the formatter for the indentation. Mechanical; touches
no behaviour.

---

### STYLE-56 — `Dock.svelte`'s `.dockbar` is an acknowledged copy of `DockHead`'s `.dock-head`, and `.grow` duplicates the global `.spacer` six times
**Severity: medium · Effort: small · Verified**

`dock/Dock.svelte:156-162`, `dock/DockHead.svelte:111-113`, `:124`, `:36`, `:114-115`;
`rail/FeatureCard.svelte:188-189`; `app.css:119`

`Dock.svelte:156` carries the comment "The same bar DockHead draws, for the selections that have no
DockHead" and then draws it again:
`padding:12px 16px; gap:10px; flex:none; flex-wrap:wrap; border-bottom:1px solid var(--border); background:var(--fc-wash, var(--panel)); box-shadow:inset 4px 0 0 var(--fc, transparent);`
— identical to `DockHead:111-113` apart from declaration order. Both then declare their own
`.grow { flex:1; }` even though `app.css:119` already ships `.spacer { flex:1; }` globally, which
SettingsModal/IntakeModal/DialogHost/TopBar use. Six `.grow` copies exist in total (`Dock:162`,
`DockHead:124`, `ActionBar:216`, `CostRanking:110`, `SearchHit:87`, `UsagePanel:234`).

`.wtname` is a third near-miss: `DockHead:114-115` (`max-width:220px`) and `FeatureCard:188-189`
(`max-width:60%`) — and **`DockHead:36` claims it "Mirrors FeatureCard's second line exactly"**,
which is no longer true. That is the specific failure mode this review looks for: a reader trusts it
and does not check.

**Fix.** Promote the bar to `app.css` as `.identity-bar` and use it from both `.dock-head` and
`.dockbar`. Replace all six `.grow` copies with `.spacer`. Promote `.wtname` with one max-width, or
correct `DockHead:36`'s claim. **Land with UX-10** (the IdentityBar extraction), which supersedes
the `.dockbar` half.

---

### STYLE-57 — The status dot is reimplemented four times, each missing a different state
**Severity: low · Effort: trivial · Verified**

`app.css:138-144` is the canonical `.dot` — 9px, with `.working` (pulsing, reduced-motion aware),
`.waiting`, `.done`, `.idle` (with an inset ring) and `.stopped`, under a heading that explicitly
says "status vocabulary (dot + pill), shared by rail, fleet and palette".

- `insights/SearchHit.svelte:104-107` — its own 7px `.dot` with working/waiting/stopped, **no
  `.done`, no pulse, no idle ring**.
- `insights/IndexStatus.svelte:101-102` — a 7px `.ok-dot` with a `.warn` modifier.
- `review/ReviewPanel.svelte:366-367` — `.cdot { width:7px; height:7px; border-radius:50%; }`,
  which `app.css:159` already provides as `.chip .cdot`, and ReviewPanel uses it inside
  `class="chip"` (`:290-291`) — so the size half is redundant; only `.cdot.b`/`.cdot.a` colours are
  load-bearing.

The same session state renders at two sizes and, in SearchHit, without the pulse that is the whole
point of `working`.

**Fix.** Add `.dot.sm { width:7px; height:7px; }` to `app.css`; delete SearchHit's and IndexStatus's
local dots in favour of `class="dot sm {state}"`. Drop the redundant size declaration from
ReviewPanel, keeping only the colour rules. **Land after UX-25**, which adds a shape/glyph channel
to `.dot` — do that first so the local copies are deleted against the final rule.

---

### STYLE-58 — DiffViewport repeats its own status-letter, `kbd` and file-row markup within one file
**Severity: low · Effort: small · Verified**

`review/DiffViewport.svelte:620-622` / `:715-717` (the four status-letter colour rules, once scoped
to `.filehd .st` and once to `.jumprow .st`, identical bodies, 95 lines apart);
`:691` / `:723` (the `kbd` rule, character-identical, 32 lines apart);
`:405-419` / `:561-573` (the file row — status letter + path + `+added`/`−deleted` stat block —
written twice). The `{#if x.added}<span class="add">+{x.added}</span>{/if}{#if x.deleted}…{/if}`
pair appears three times in this file and again at `ReviewPanel:336-337`.

This is the largest component in the client and the one where a reader is most likely to change a
rule and miss its twin.

**Fix.** Collapse `.st` and `kbd` to unscoped-within-component selectors (`.st.m { … }`, `kbd { … }`)
— Svelte already scopes them, so the `.filehd`/`.jumprow` and `.legend`/`.jumpfoot` prefixes buy
nothing. Extract `{#snippet stat(added, deleted)}` and `{#snippet fileRow(block)}`; use the stat
snippet from `ReviewPanel` too if you move it somewhere shared.

---

### STYLE-59 — SearchPanel writes the same terms-list template twice, five lines apart
**Severity: low · Effort: trivial · Verified**

`insights/SearchPanel.svelte:292` and `:296` are the identical
`{#each terms as t, i (i)}<code>{t}</code>{#if i < terms.length - 1}<span class="and"> and </span>{/if}{/each}`,
differing only in that the second is guarded by `{#if terms.length > 1}`. Both live in the same
`<p class="meta">` chain of `{:else if}` branches — a paragraph whose entire job is to explain
precisely what was matched (the honesty line the file header at `:9-14` argues for). Two copies
means the panel could explain the query differently depending on whether there were hits.

**Fix.** `{#snippet termList()}` above the markup, called from both branches.

---

### STYLE-60 — Two segmented controls with two implementations, and `.chip` means three different things
**Severity: low · Effort: small · Verified**

`review/ReviewPanel.svelte:372-376` (`.seg`/`.segbtn` — outer border, `border-left` dividers, square
inner corners, `var(--mono)` 11.5px) and `insights/UsagePanel.svelte:267-272` (`.viewseg` — inset
track, 2px padding, rounded pills, `var(--sans)` 11.5px) are the **same widget**: a two-option
`role="group"` where the active one wears `--brand`/`--brand-ink`, drawn two different ways.

Separately `.chip` carries three unrelated meanings: `app.css:157` (rounded mono status chip,
radius 20), `LinkChip.svelte:56-58` (link chip, radius 6, max-width 260px, scoped so it overrides),
`DialogHost.svelte:230-235` (a 26px square colour swatch). `class="chip"` tells a reader nothing
about what they will get until they check which file they are in.

`FeatureCard:198-199` likewise re-declares `.src`, which `app.css:158` already defines, with drifted
font-size (10px vs 10.5px) and padding (`1px 5px` vs `1px 6px`) — silent drift: the rail's tag is a
hair smaller than every other `.src` in the app for no stated reason.

**Fix.** Pick one segmented-control style (the `.viewseg` inset-track form is the more modern), put
it in `app.css` as `.seg`/`.seg button`, delete both local copies. Rename DialogHost's swatch to
`.swatch-chip` and LinkChip's to `.linkchip` so the global `.chip` means one thing. Either delete
FeatureCard's `.src` override or add a one-line comment saying why the rail's is smaller.
**Overlaps UX-12** (the missing type/space/radius scale) — do UX-12's tokens first, then this.

---

### STYLE-28 — Keyboard bindings are described in three places and two have drifted from the handler
**Severity: medium · Effort: small · Verified · Also tracked as UX-17 / UX-23 in the design doc**

`client/src/lib/shortcuts.svelte.ts:43` (`ROWS` cheatsheet), `:49`, `:54`, `:144`;
`components/Palette.svelte:71`; `components/Terminal.svelte:250`

Three independent statements of "which key does what": the live handler (`handleShortcut` plus
`Terminal.svelte`'s `BINDINGS` map at `:247-252`), the cheatsheet array `ROWS`, and the palette's
`sub` hint strings. Two have drifted:

- **`Palette.svelte:71`** advertises `⌘↵` as "Promote current to worktree". The comment at
  `shortcuts.svelte.ts:144-152` explains that ⌘↵ was **taken away** from Promote and given to the
  terminal, and `Terminal.svelte:250` confirms `'meta:Enter': '\n'`. Pressing it inserts a newline.
- **`shortcuts.svelte.ts:49` and `:54`** are two `⇧↵` rows in the same twelve-row array with
  different descriptions, and `:49` duplicates `:50`'s `⌘↵` entry in meaning. The cheatsheet lists
  ⇧↵ twice and omits `⌥←/→` (`Terminal.svelte:251-252`), which it does bind.

`ui.svelte.ts:343-357` describes exactly this failure shape for ⌘1–9 and the cure that fixed it
(`railDigits`, deriving both from one list). The same cure has not been applied to the key table.

**Fix.** One exported table in `shortcuts.svelte.ts`
(`export const KEYS = { newSession: {combo:'⌘N', label:'New session'}, … }`) plus a `TERMINAL_KEYS`
list mirroring — or better, derived from — `Terminal.svelte`'s `BINDINGS`. Build `ROWS` from
`Object.values(KEYS)`; replace Palette's literal `sub` strings with `KEYS.<x>.combo`. Then delete
the `'⌘↵'` from the Promote row, drop the duplicate ⇧↵ row, and add ⌥←/→.
