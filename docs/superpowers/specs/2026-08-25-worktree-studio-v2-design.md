# Worktree Studio v2 — Design

Written 2026-08-25. Supersedes nothing; v1 keeps running until v2 is better.

This is a **from-scratch rewrite**, not a refactor. v1 (~20k lines of server, ~5k of
client, 472 commits) works and taught us what the product is. v2 keeps the thesis,
re-derives the domain model, and deletes the machinery that only existed because the
model was missing.

---

## 1. What Studio is

**One place to start, watch, and steer coding-agent sessions — across several projects,
many repos, and a fleet large enough that you cannot hold it in your head.**

The origin of work is a real agent session booted on your `CLAUDE.md` (or the equivalent
for whatever agent you configure), not a form. It runs in an embedded terminal backed by
a persistent tmux session. When the work is real you **promote** it — one action creates
a worktree, carries your gitignored local config in, and the same conversation continues
into it.

v2's new claim on top of that: **Studio manages your attention, not just your processes.**
At 25–50 features across 2–3 projects with 5–10 stacks running, the scarce resource is
not compute. It is knowing what wants you right now, and being able to put down
everything else until tomorrow.

---

## 2. Principles

These decide arguments later. They are in priority order.

1. **Studio owns the world outside the conversation; the agent owns everything inside its
   repo.** Any feature that duplicates an agent capability must justify itself by being
   useful *when no session is live*. This is why v2 has no hunk staging, no commit-message
   composer, and no PR-body authoring — the agent does those better, in context.
2. **Lifecycle is declared; liveness is derived. They never mix.** Where a feature sits in
   your head (active, snoozed, blocked) is set by you or by an event. Whether its servers
   are up is observed. A snoozed feature with running servers is a legal, meaningful state.
3. **A feature is a record Studio owns**, not something inferred from directory names.
   Everything hard in v1's identity layer follows from getting this wrong.
4. **Nothing is required inside your repos.** Studio must work against a repo that has
   never heard of it. In-repo configuration is an optional override, never a prerequisite.
5. **The interface is checkable offline.** Fixtures mode and the state gallery exist from
   the first week and shape the client architecture, rather than being retrofitted.
6. **One command reproduces CI.** `npm run verify` runs exactly what CI runs. In CI,
   cheap checks (format, lint) are **sibling jobs** to expensive ones (typecheck, test),
   never sequential steps — a formatting failure must never be able to prevent the test
   suite from running.
7. **Degrade loudly.** When a capability is unavailable — an agent with no permission
   hook, a source with no credentials, an index that is cold — the UI says so. It never
   shows an empty state that reads as "nothing to report."

---

## 3. Domain model

### 3.1 Hierarchy

```
Workspace            Accept Blue, Mercury Studio, Lab
└── Repo             api, web, admin, portal        (a repo belongs to exactly one workspace)
    └── Worktree     one per repo per feature
Feature              the unit of work; spans 1..n repos within one workspace
├── Session          a live agent process in tmux; 0..1 per feature (plus history)
├── Run              a task execution with status/duration/exit code
├── Review           per-feature review state and notes
├── InboxItem        things wanting the agent's attention
└── TimelineEvent    the feature's history
```

**Workspace** is the top level. It owns repos, source connections, stack profiles,
recipes, and agent defaults. Features belong to exactly one workspace. Repos belong to
exactly one workspace (confirmed: no shared repos across projects).

**Concurrency slots are allocated globally**, across all workspaces — ports are a
machine-wide resource and two workspaces cannot independently believe they own slot 1.
There is one global cap, not per-workspace budgets.

### 3.2 Lifecycle states

| State | Meaning | Set by |
|---|---|---|
| `queued` | intake'd, not started | intake / triage |
| `active` | being worked | you, or first session start |
| `review` | diff or PR ready for you | auto on PR/MR open |
| `snoozed` | deferred until a wake time | you (with a date) |
| `blocked` | waiting on a person or thing, with a reason | you (with a note) |
| `done` | merged or closed; worktree may still exist | auto on merge |
| `archived` | out of sight, still searchable | you, or auto 14d after `done` |

Automatic transitions: PR/MR opened → `review`. PR/MR merged → `done`. Snooze wake →
back to its previous state. Nothing else moves a feature without you.

### 3.3 Liveness (derived, never stored as state)

Agent status (§7.1), running servers and their ports, slot, CI result, PR/MR state and
unanswered comment count, commit count and diff size ahead of base, uncommitted changes,
last activity timestamp.

### 3.4 Schema sketch

SQLite, one file, numbered SQL migrations run at boot against `PRAGMA user_version`.

```
workspace(id, name, slug, color, agent_defaults_json, created_at)
repo(id, workspace_id, name, path, default_branch, stack_profile_id)
feature(id, workspace_id, name, state, snooze_until, blocked_reason, pinned,
        recipe_id, source_ref_id, created_at, updated_at)
worktree(id, feature_id, repo_id, path, branch, base_ref, created_at)
session(id, feature_id, provider, tmux_session, agent_session_ref, status,
        status_detail_json, active, created_at, last_seen_at)
tab(id, session_id, tmux_window_id, name, kind)
run(id, feature_id, worktree_id, label, command_json, status, exit_code,
    started_at, ended_at, log_path)
server(id, worktree_id, pid, ports_json, source, log_path, started_at)
slot_claim(slot, feature_id, resources_json, claimed_at)          -- global
review(id, feature_id, state, updated_at)
review_file(review_id, repo_id, path, blob_sha, reviewed_at)      -- invalidated on change
review_note(id, review_id, repo_id, path, line, body, sent_at, external_ref)
inbox_item(id, feature_id, kind, payload_json, created_at, delivered_at,
           dismissed_at, dedupe_key)
timeline_event(id, feature_id, kind, payload_json, at)
permission_rule(id, scope_kind, scope_id, tool, target_glob, effect, message, created_at)
recipe(id, workspace_id, name, config_json)
source_connection(id, workspace_id, kind, config_json, credential_ref)
source_item(id, source_connection_id, external_id, title, body, url, state,
            sync_token, updated_at)                               -- the queued backlog
transcript_doc / transcript_fts                                    -- FTS5
provenance(session_id, feature_id, repo_id, path, op, at)          -- §11.2
```

Secrets (source tokens, the API token) live outside the database in the OS keychain or a
0600 state file, referenced by `credential_ref`. The database is safe to copy.

---

## 4. The shell

Three surfaces, each answering exactly one question, so none of them has to answer all
three badly.

### 4.1 Rail — "what am I doing?"

Left column, scoped to the current workspace. One row per feature, showing only
`active`, `review`, and anything whose agent is waiting on you. Grouped: **Needs you** ·
**Active** · **In review**, active-first within each. Pinned features sort to the top of
their group regardless.

Cards are readouts and carry no buttons. Each row shows: state dot, name, repos, and at
most two liveness signals (server count, CI mark, PR number, "waiting 40s"). A footer
line reads `N more on the Board →`.

**Focus mode** hides every row but one.

### 4.2 Attention queue — "what wants me?" (⌘J)

An overlay over anything, **global across workspaces**, every item badged with its
workspace. This is the inbox draining (§6). Items are keyboard-worked: `j`/`k` to move,
`enter` to open, `a` to allow a permission, `s` to snooze, `w` to narrow to the current
workspace, `esc` to dismiss.

Acting on an item from another workspace resolves it **in place** — it does not switch
workspace. Only `enter` navigates.

Its length tracks demand rather than inventory, which is why it is the only surface that
does not get worse as the fleet grows.

### 4.3 Board — "what do I own?" (⌘B)

Scoped to the workspace, with an all-workspaces toggle. Columns are the lifecycle states.
Cards carry name, repos, ticket, and liveness badges. **Cost is not shown here** — it
lives on the Timeline and a usage view.

Triage interactions are the point:
- Drag into **Snoozed** → asks for a wake time (tomorrow 9am / next week / a date).
- Drag into **Blocked** → asks for a one-line reason, shown on the card.
- **Done** offers worktree and branch cleanup.
- Select several **Queued** cards → start them together (batch intake, §10.3).

### 4.4 Dock, action bar, header

**Dock** (right) — the selected feature's identity header and its panels: terminal tabs ·
✎ Changes · ▸ Logs · ▶ Runs · ⏱ Timeline.

**Action bar** (bottom) — every verb for whatever is selected. The rule from v1 holds and
is worth restating: *the top says what you are looking at, the bottom does something to it.*

**Header** — workspace chip at top-left (`◆ Accept Blue ▾`) opening a list with
per-workspace counts and ⌃1–9 shortcuts; ⌘J / ⌘B / ⌘K affordances; and an attention
readout that distinguishes **here** from **elsewhere** (`2 here · 1 elsewhere`). The
elsewhere count is the entire reason the workspace layer is honest.

---

## 5. Sessions and worktrees

### 5.1 Sessions

Real agent processes inside **tmux** (dedicated socket, chrome-free config), streamed to
an xterm.js terminal over WebSocket. tmux stays because it is what makes sessions survive
a daemon restart, gives an escape hatch when the UI is broken, and — most importantly —
makes agent-agnosticism nearly free: running any agent is running a command in a pane.

It sits behind a driver interface so node-pty remains a swappable backend.

Multiple tabs per session, addressed by tmux window id. Rename, deactivate (stop the
process, keep it resumable), reactivate, delete. Resume after daemon restart via the
session registry plus the provider's resume command; tmux sessions are reattached and
tabs reconciled.

**Never type unbounded text into a tty.** Launch commands are written to a file and
sourced with a short `. <file>`; the typed line is asserted under 1024 bytes by a test.
(v1 lesson: canonical-mode input truncation at `MAX_INPUT` silently corrupted launches.)

### 5.2 Un-promoted sessions

Both modes are required. A session starts in the repo's main checkout — you can ask
questions without earning a branch — and is promoted when the work is real.

**More than one un-promoted session per repo must be supported.** v1's hazard (two agents
sharing a checkout, clobbering each other's work) is solved not by a lease but by
**giving each un-promoted session its own scratch worktree** off the current HEAD,
created on start and discarded on delete. It is invisible in the UI — the session simply
has a private working copy — and promotion converts it in place by renaming the branch off
the default branch. No shared checkout, no lease, no lock.

### 5.3 Promotion

Creates `<repo>/.worktrees/<name>` (default layout `nested`; `sibling` and `external`
remain as a single config key that affects exactly one path-derivation function and
nothing else) on a fresh branch off the default branch, copies local config in, and tells
the live session to relocate its working directory and transcript.

Uncommitted changes and un-pushed commits in the origin can come along: changes by stash,
commits by cutting the branch from HEAD. Neither is ever silently left behind.

**One copy list, not two.** v1's `copyPatterns` (only if gitignored) and `copyAlways`
(regardless) collapse into a single list. Copy if the file exists; if the destination is
tracked *and* modified, skip it and say so in the create report. JetBrains run configs and
`.env`-style local config are in the default list.

### 5.4 Multi-repo features

A feature spans 1..n repos of its workspace. Repos are added up front (intake
"also touches") or on the fly from the UI or from inside the session via the CLI. Adding
a repo creates a same-named worktree and grants the live session access to that directory.

**Adoption** replaces v1's identity inference: a worktree found on disk that belongs to no
feature is offered for adoption, once, with a suggested feature to join.

### 5.5 Cleanup and reclaiming disk

Worktrees accumulate. At 25–50 features with `node_modules` in each, they are also the
largest thing Studio puts on your disk. Cleanup must be **safe enough to do in bulk without
reading carefully**, or it will not happen and the disk will fill.

**Archiving and deleting are different acts.** Archiving a feature removes its *disk
artifacts* and keeps its record — timeline, reviews, notes, transcripts, run history — in
the database forever. You never lose history by cleaning up. This is what makes bulk
cleanup psychologically safe, and it is the default.

**The safety gate.** A worktree is never removed while it holds work that exists nowhere
else:

| Condition | Behaviour |
|---|---|
| uncommitted changes | skipped, named, requires explicit per-repo confirmation |
| commits not on any remote | skipped, named, requires explicit per-repo confirmation |
| branch not merged into the default branch | worktree may be removed; **branch is kept** |
| clean, pushed, merged | removed freely |

Branch deletion is always a separate opt-in, defaulting off, and never happens to an
unmerged branch without a typed confirmation. Removing a worktree is not reversible;
keeping the branch means the work is.

**Per-feature cleanup** is one action from the action bar or the Board's `done` column. It
shows exactly what will happen before it happens: stop N servers, deactivate the session,
remove N worktrees, free the slot, reclaim X GB — with anything the gate caught listed by
name. Nothing is automatic.

**Bulk cleanup** on the Board: select several `done` or `archived` features and clean them
together. The pre-flight is a single summary — *"12 worktrees, 4 branches, 18.4 GB · 2
features skipped: unpushed commits in `api`, uncommitted changes in `web`"* — so the common
case is one confirmation and the unsafe cases are visible rather than buried.

**The Maintenance view** answers "what can I reclaim?" without requiring you to remember
what you finished. Ranked by reclaimable size:

- features `done` or merged whose worktrees are still on disk
- **orphan worktrees** — on disk, belonging to no feature and declined for adoption
- worktrees whose branch is fully merged into the default branch
- worktrees untouched for N days
- `node_modules` size per worktree, listed separately — often the bulk of it, and
  removable without touching the worktree itself
- prunable git administrative state (`git worktree prune`)

**Cleanup gets suggested, never performed.** When a PR merges, the feature moves to `done`
and an attention item appears: *"gl-webhooks merged — clean up 2 worktrees, 1.8 GB?"* One
keystroke. This is the mechanism that actually keeps the disk flat; a maintenance view
nobody visits does not.

`wt-studio clean --dry-run` prints the same plan from a terminal, and the dry run is the
default.

---

## 6. The inbox — v2's core primitive

Everything that wants an agent's attention is the same shape: *a message delivered to a
feature's session.* v1 had five unrelated pathways for this. v2 has one.

### 6.1 Producers

| Producer | Fires when |
|---|---|
| CI failure | a watched branch's CI turns red — carries the failing job and a trimmed log |
| Auto-verify failure | the feature's verify run fails after the agent goes idle (§8) |
| Review notes | you send a bundle of your own annotations (§11) |
| PR/MR review comments | unresolved review threads appear on the feature's PR |
| Ticket comments | a new comment arrives on the linked issue/task (opt-in, §10.4) |
| Overlap warning | another live feature is editing files this one is also editing |
| Snooze wake | a snoozed feature's wake time arrives |

### 6.2 Delivery rules

- **Never interrupt a working agent.** Items queue while status is `working` and drain
  when it reaches `idle` or `waiting:input`.
- **Coalesce.** Multiple items for one feature drain as a single message with sections.
- **Dedupe** on `dedupe_key` — the same CI failure for the same sha is one item forever.
- **Cap.** A configurable maximum of automatic deliveries per feature per hour, after
  which items accumulate visibly rather than being delivered.
- **If no session is live**, the item waits, and the feature shows a badge. Optionally
  (per recipe) the session is reactivated to receive it.
- Every delivery and every dismissal is a Timeline event.

### 6.3 Surfacing

Items that need *you* rather than the agent (a permission request, a question, a review
that is ready) appear in ⌘J. Items destined for the agent appear there too, as a
one-keystroke **Hand to agent** — automatic delivery is opt-in per feature or recipe.

---

## 7. Agent adapters

### 7.1 The contract

Each provider declares:

```ts
{
  id, displayName,
  launch:    (ctx) => string,          // command to start a fresh session
  resume:    (ctx) => string,          // command to resume by reference
  addDir?:   (ctx, dir) => Injection,  // grant access to another repo
  inject:    (ctx, text) => Injection, // deliver an inbox message
  status:    StatusCapability,         // how state is reported
  permissions?: PermissionCapability,  // how approval requests surface
  cost?:     CostCapability,
}
```

`StatusCapability` is one of:
- `hooks` — the agent can call back into Studio on lifecycle events (Claude Code).
- `patterns` — Studio infers status from tagged output lines the adapter describes.
- `none` — Studio reports only *running* / *not running*.

Studio ships adapters for **Claude Code** and **Codex**, plus a generic `command` adapter
with `status: none`. New providers are configured in Settings, not in code.

### 7.2 Honest degradation

A provider without `permissions` gets no approval queue, and the UI **says** the agent
cannot report permission requests rather than showing an empty queue. Same for status and
cost. This is principle 7 and it is the difference between agent-agnostic and
agent-pretending.

### 7.3 Per-session settings

Studio generates a per-session settings/hook file for providers that support it, wiring
lifecycle events back to the daemon. **Your global agent configuration is never touched.**

---

## 8. The closed loop

The feature that changes what Studio is for.

```
agent goes idle
  → Studio runs the feature's verify configuration(s)
      → passes  → Timeline event; nothing else happens
      → fails   → inbox item with the failing output
                    → delivered to the agent
                      → agent fixes, goes idle
                        → repeat
```

Bounded by: a **round cap** (default 3), a **wall-clock cap**, a visible **Stop** at all
times, and the delivery cap from §6.2. Each round is a Timeline entry, so the loop is
always auditable after the fact.

Enabled per feature or per recipe, off by default. The verify configuration is chosen from
the feature's discovered run configurations (§9.2).

Combined with time-boxed unattended permission windows (§12), this is what lets a feature
make progress while you are somewhere else — and the caps are what make that safe to offer.

---

## 9. Stacks, servers, runs

### 9.1 Dev servers and slots

Discovery is by listening-port → cwd, so a server started by hand in WebStorm shows up on
its worktree's row. Start / stop / restart operate on the whole feature. Per-worktree log
files, tailed live.

**Slots, made generic — with zero changes to any repo.** A slot is an integer. From it:

1. **Derived values** — `port(base)` → `base + slot × step`; `index` → the slot number;
   `name` → `slot-N`.
2. **Sinks** — how a value reaches the process:
   - `env` — `{ "api__port": "{port:1233}" }`
   - `argv` — append `-- --port {port:3030}` (this is v1's `portFlag`, generalized)
   - `file` — patch a path inside a JSON/JS file in the worktree (v1's frontend local-config
     patching, generalized)
   - `template` — render a whole file from a template
3. **Exclusive roles** — a named singleton (`scheduler`, `cron`, `queue-consumer`) awarded
   to exactly one live slot, delivered to it as its on-value and to every other slot as its
   off-value. This is v1's `job_schedule` with no accept.blue in it.

The declaration is a **stack profile**, stored in Studio's own config directory
(`stacks/accept-blue.json`) and attached to a repo. Studio prefers an in-repo
`.wtstudio/stack.json` if one exists, but **never requires it** — the ab repos need no
changes, ever (principle 4).

**Claim-based allocation.** A slot claims its ports and index; Studio verifies they are
free before start rather than assuming arithmetic worked, and reports a collision by name.
At 5–10 concurrent stacks this stops being optional. Claims are global across workspaces.

The shared dev database stays shared across slots — deliberately out of scope.

### 9.2 Run configurations

Read live from each worktree, no import step:
- `.idea/runConfigurations/*.xml` (JetBrains)
- `.vscode/tasks.json` and `.vscode/launch.json`

Grouped by repo. A configuration is a **server** (tracked with a pid and a log) if its
script looks like one, if VS Code marks it `isBackground`, or if it matches the repo's
configured start command; otherwise it is a **task**, tracked as a **run**. An
unrecognised configuration type is skipped, never guessed at — these produce commands that
get executed.

### 9.3 Runs panel

Every run for the feature's worktrees, newest first: status, duration, exit code, output.
Re-run repeats the **recorded** command, not whatever the configuration says today. Stop
kills the process group. Last 60 kept; survives a daemon restart, and a run that was live
when the daemon died is marked *stopped* rather than left claiming to be in progress.
Output is tailed by byte offset while running and stops polling the instant it ends.

---

## 10. Intake and sources

### 10.1 Sources

Free text, **Asana**, GitHub, GitLab. Every source resolves to one seed shape
`{ title, body, url, externalId }` which seeds the session's first message. Source
connections belong to a workspace — Accept Blue's Asana org and Mercury's GitHub org are
separate configurations.

In our UI, Asana's own "workspace" is called **Asana org**, to keep our word unambiguous.

### 10.2 The poller — delta, not naive

Webhooks are rejected: they require a publicly reachable HTTPS endpoint, and Studio binds
`127.0.0.1`. A tunnel is a new dependency, a new failure mode, and an internet-exposed
surface on your laptop, in exchange for seconds of latency.

| Source | Delta mechanism | Fallback |
|---|---|---|
| Asana | Events API sync token — `412` means re-sync from scratch | hourly full re-read |
| GitHub | conditional requests (`ETag`/`If-None-Match`) + `since` | `gh` on demand |
| GitLab | `ETag` + `updated_after` | `glab` on demand |

Asana's Events API is explicitly faster and more generously rate-limited than reading the
resource, retains events for 24h, and expires sync tokens after 24h or sooner under load.
Delivery is at-most-once, so the hourly reconcile is required, not optional.

Polling runs **only while a browser stream is open**, plus a slow background tick for
anything that must reach the menubar. A webhook receiver remains a documented, opt-in path
for the day a tunnel exists.

### 10.3 Queued work

Source items land as `queued` features — visible on the Board and in intake, never in the
rail. Triage is dismiss / snooze / start. Selecting several and starting them together is
supported.

### 10.4 Write-back ladder

| Level | Behaviour | Default |
|---|---|---|
| L1 Link | the feature remembers its ticket; PR bodies reference it; rows link to it | **on** |
| L2 Status sync | promote → In Progress; PR opened → In Review; merged → Done | **opt-in** |
| L3 Comment on open | post the PR link (and optionally a summary) to the ticket | opt-in |
| L4 Comments in | new ticket comments become inbox items | opt-in |

Every write-back path has a **dry-run mode** that logs what it would have done. This is the
only part of Studio that touches things other people can see, and it is treated that way.

---

## 11. Review

### 11.1 Read and annotate — nothing else

Per principle 1, v2 has **no hunk staging, no commit composer, no PR body authoring**. The
agent does those in context and does them better.

The ✎ Changes panel shows, aggregated across the feature's repos and grouped by repo: the
branch's commits (`base..HEAD`, base = closest merge-base with the default branch), newest
first, plus each repo's uncommitted working changes pinned on top. Click a commit for all
its file diffs; click a file for just that file.

**Annotation** is the point. Mark a file *reviewed* or *needs work*; attach notes anchored
to file and line. Reviewed-ness is keyed by **file + blob sha**, so it invalidates the
moment the agent touches that file again. **Send review** bundles the notes into one inbox
item.

Review records live in Studio's database and **survive the worktree being deleted**.

**PR/MR review comments are the same thing from the other direction.** Unresolved threads
on the feature's pull request become review notes with an `external_ref`; the agent
addresses them, and — opt-in — replies to the thread and resolves it. Your annotations and
a colleague's GitHub comments are one queue.

### 11.2 Search

Two searches, one query box with a mode toggle:

**(a) Conversation** — FTS5 over transcript prose. Results are snippets with surrounding
turns, filterable by workspace/feature/repo/date; opening one drops you into that session
at that point. The index reports its own health, and says so when an empty result set
would be misleading.

**(b) Provenance** — built from tool-use events (every write target) and worktree git
history, not from prose. Ask about a path and get which features touched it, when, and
what changed. This also feeds the **overlap radar**: two live features editing the same
files is a merge conflict you can see coming, surfaced as a rail signal and an inbox item.

---

## 12. Permissions

### 12.1 Status vocabulary

`working` · `waiting:input` · `waiting:approval` · `idle` · `stopped` · `crashed`

Only `waiting:approval` carries a payload, and the payload is the point: **tool, target,
risk class**. `Bash · npm run test:integration`. That is what makes a request answerable
from the rail row or ⌘J without opening the terminal — which at 5–10 concurrent agents is
the difference between two seconds and losing your place.

### 12.2 Rules

`(tool, target-glob) → allow | ask | deny`, resolved global → workspace → repo → feature,
most specific wins.

```
allow  Bash   npm run test*
allow  Edit   **                    # within its own worktree only
ask    Bash   git push*
deny   Bash   **/migrate*           with message "use the seed script"
deny   Read   ~/.ssh/**
```

- **"Always allow" asks for a scope** — this session / this feature / this repo / this
  workspace / everywhere — and writes the rule there. Feature scope is the one you usually
  mean and the one no agent's own permission memory can express.
- **Deny carries a message**, delivered to the agent. A denial that teaches is worth ten
  that block.
- **Unattended windows** — "run unattended for 30 minutes," time-boxed, per feature,
  expiring on its own. This is what makes §8 usable while you are away, and the time box is
  what makes it safe to offer.
- **Everything is audited** on the Timeline: what was asked, how it was answered, by whom
  or by which rule.

---

## 13. Recipes

A named, reusable starting configuration:

| Field | Example |
|---|---|
| repos | primary `api`, also-touches `web` |
| provider + model | inherited from the workspace, overridable |
| seed template | `Fix {{ticket.title}}\n\n{{ticket.body}}\n\nReproduce with a test first.` |
| extra dirs | `~/code/shared-types` |
| permission rules | a ruleset from §12 |
| auto-verify | which run configuration(s), and whether the loop is on |
| servers | start the stack on promote, or don't |
| branch/worktree pattern | `fix/{{ticket.id}}-{{slug}}` |
| lifecycle defaults | initial state; auto-snooze after N idle days |
| intake binding | Asana tasks tagged `bug` in project *Platform* default to this recipe |

Shipping examples: **Bug fix** · **Spike** (no worktree, no servers, no verify,
auto-archive after 3 days — this is what makes the un-promoted session a first-class mode
rather than a leftover) · **FE+BE feature** · **Dependency bump**.

The design detail that makes the library survive: **a recipe has the same shape as a
feature's configuration**, so *Save as recipe* on an existing feature is one action. You
never author one from scratch.

---

## 14. Surfaces

- **Menubar** (SwiftBar) — a thin API client, global across workspaces, grouped by
  workspace, one number in the title picked by urgency. Reports the daemon's own health
  from launchd, distinguishing *running under the agent*, *started by hand*, *starting or
  wedged*, and *crash-looping* — because "not running" with a Start button is useless when
  `KeepAlive` is already pressing it.
- **Deep links** — `#w:<workspace>` · `#f:<feature-id>` · `#s:<session-id>`. Ids are
  globally unique, so following a link switches workspace on the way. Works in an already
  open tab (listen for `hashchange`, not a startup read) and rewrites the fragment on
  navigation with `replaceState`.
- **Notifications** — desktop notification and optional sound when a session needs you.
  Global across workspaces. Tab-title prefix and header badge carry the count.
- **Command palette (⌘K)** — global; jump to any feature in any workspace, or run any verb.
- **CLI (`wt-studio`)** — for use from inside an agent session: `add-repo`, `state`,
  `note`, `verify`. The agent can act on Studio; Studio's API is the only pathway.
- **Fixtures mode** — serves a frozen fleet, no scan, no watchers, no external binaries,
  every mutating route answers 409, a banner that nothing is real. Enforced, not promised.
  A live fleet can be captured to a fixture file for later replay.
- **Gallery** — every state a surface can take, on one page, from the same fixture factory
  the component tests use. Adding a state adds a gallery cell and a test case together, so
  the two cannot describe different apps.

---

## 15. Stack

Full TypeScript, both halves. No hedging toward a future port in another language.

| Layer | Choice | Rejected |
|---|---|---|
| Runtime | Node 22+, TypeScript | Go (single binary, better process supervision — but loses shared types and the JS-first agent ecosystem, and does not help with the modeling problems that made v1 messy). Bun (native-module risk for a pty-heavy daemon). |
| HTTP | Hono | Express (familiarity only), Fastify (heavier plugin model) |
| Validation | Zod at the boundary; `api.md` generated from the schemas | hand-written API docs (v1's 1,515-line doc drifts) |
| Types | Server exports, client imports — directly, no codegen | schema-first codegen (only justified by a port that is not happening) |
| Realtime | SSE for state, WebSocket for terminals | one WS for both (loses free SSE reconnect and curl-ability) |
| Frontend | Svelte 5 + plain Vite | SvelteKit (no routing or SSR is used; costs a build step and an explanation), React |
| Store | SQLite via `node:sqlite`, plain SQL, numbered migrations | JSON files (v1 — cannot carry this model), an ORM (overkill at ~20 tables) |
| Git | `git` via exec, behind one tested wrapper | simple-git, isomorphic-git (a library does not fix porcelain parsing; tests do) |
| Terminal | xterm.js + fit/webgl/search/unicode11 | — |
| Multiplexer | tmux, behind a driver interface | node-pty (loses process survival and the escape hatch) |
| Tests | Vitest for both halves | v1's split of node:test + vitest (a seam that makes people run half the suite) |
| Lint/format | Biome | ESLint + Prettier |

**Dev loop:** Vite dev server with HMR for the client, `tsx watch` for the daemon. There is
no "rerun `npm run build` after client changes" step — that friction was packaging, not
language.

---

## 16. Distribution

- **Tier 1 — clone.** `git clone && npm ci && ./install.sh --autostart`. For your own
  machines.
- **Tier 2 — GitHub Releases** (built now). CI produces a tarball with the server bundled
  to a single JS file, the **pre-built client**, and runtime deps only. No TypeScript
  build, no client build, no network at install time. `node-pty` ships macOS arm64/x64
  prebuilds, so nothing compiles on the target and the spawn-helper permissions step
  disappears. **The release artifact containing the built client is also what makes build
  skew impossible** — the user cannot have a stale one.
- **Tier 3 — Homebrew tap** (later). A formula depending on `node` and `tmux`, installing
  the Tier 2 tarball; `brew services` replaces the launchd plist.
- **Tier 4 — single binary.** Rejected; native modules make it painful and it buys little.

---

## 17. What v1 had that v2 deliberately does not

| Dropped | Why |
|---|---|
| Feature identity strategies (`basename`/`branch`/`manifest`) and manual `groups` | Features are owned records. Inference survives only as one-time adoption. |
| Hunk-level staging | Principle 1 — the agent stages and commits. |
| Commit-message composer, Commit & PR, PR body authoring | Principle 1. |
| `copyPatterns` vs `copyAlways` | One list. |
| Checkout lease (planned in v1) | Per-session scratch worktrees make the shared checkout impossible. |
| Alfred integration | Unused; the palette and deep links cover it. |
| Hand-written `docs/api.md` | Generated from zod schemas. |
| Two test runners | One. |
| Cost on cards and the board | Timeline and a usage view; not in peripheral vision. |

---

## 18. Build order

Each phase is usable on its own; nothing is a big-bang cutover, and v1 keeps running until
a phase makes it redundant.

1. **Skeleton** — daemon, SQLite + migrations, workspace/repo/feature model, discovery,
   state endpoint, SSE. Fixtures mode and the gallery exist from here.
2. **Sessions** — tmux driver, Claude Code adapter, terminal, tabs, scratch worktrees,
   promotion, resume. The rail and the dock.
3. **Lifecycle** — states, snooze, pin, focus, the Board, the workspace switcher.
4. **Attention + inbox** — ⌘J, the inbox with the permissions and CI producers, the split
   status vocabulary.
5. **Stacks** — stack profiles, sinks, exclusive roles, claim-based slots, servers, run
   configurations, the Runs panel.
6. **The closed loop** — auto-verify on idle, round caps, unattended windows.
7. **Review** — diff reading, annotation, send-to-agent, PR/MR comment ingestion.
8. **Sources** — free text, Asana with the Events poller, GitHub/GitLab, queued backlog,
   batch start, write-back L1/L2.
9. **Search** — transcript FTS, provenance index, overlap radar.
10. **Recipes, timeline, cost, menubar, CLI, packaging.**

---

## 19. Open questions

- **Second provider.** Codex is the intended second adapter; its status capability needs
  confirming against reality before §7's three-tier model is locked.
- **Overlap radar precision.** File-level overlap will produce false positives on shared
  lockfiles and generated files; needs an ignore list, and possibly hunk-level comparison.
- **Snooze wake and slots.** A feature waking with `servers: start` set may find its slot
  taken. Current answer: it wakes without servers and says so. Worth revisiting.
- **Transcript index size** at 25–50 features over months — no measurement yet.
