# Build prompt — Worktree Studio v2

Hand this to a fresh session in an empty repository, with
`2026-08-25-worktree-studio-v2-design.md` copied in alongside it.

---

You are building **Worktree Studio v2** from scratch in this empty repository.

**Read `docs/2026-08-25-worktree-studio-v2-design.md` first, completely, before writing
anything.** It is the specification: domain model, surfaces, subsystems, stack decisions,
build order, and an explicit list of things v1 had that v2 must not. Where this prompt and
the spec disagree, the spec wins on *what to build*; this prompt governs *how to build it*.

There is a v1 of this app. **Do not read it, port from it, or consult it** unless the spec
names a specific v1 behaviour and you need the detail — v1's accumulated shape is exactly
what this rewrite exists to escape. The spec already carries everything worth keeping,
including v1's hard-won lessons.

## What you are building, in one paragraph

A local daemon plus a web UI that starts, watches, and steers coding-agent sessions across
several projects. Sessions are real agent processes in tmux; when work is real it is
promoted into a git worktree and the same conversation continues. Features are records
Studio owns, with a lifecycle you declare (active, snoozed, blocked, review, done) kept
strictly separate from liveness it observes (processes, ports, CI, diffs). Three surfaces:
a rail of what you are doing, a global attention queue of what wants you, and a board of
everything you own. One primitive — the inbox — carries CI failures, failed verify runs,
review notes, and PR comments back to the agent that can fix them.

## How to work

**Follow the build order in §18 of the spec.** Each phase must be runnable and demonstrable
before the next begins. Do not scaffold phase 5 while phase 2 is unfinished.

**Test-drive everything.** Write the failing test first, watch it fail, then make it pass.
This applies to the server and the client equally.

**Fixtures mode and the gallery exist from phase 1**, not as a retrofit. They shape the
client architecture: every surface renders from a fixture factory, and adding a state to
the gallery adds a test case at the same time. If a surface cannot be rendered from a
fixture, its architecture is wrong.

**One `npm run verify`** runs format, lint, typecheck, and both test suites, and it is
exactly what CI runs. In CI, format and lint are **sibling jobs** to typecheck and test —
never sequential steps, so a cosmetic failure can never prevent the suite from running. Add
a pre-push hook that runs `verify`.

**Never claim something works without running it.** Paste the command and its output. A
test suite that hangs, a diff that vanishes, or a check that passes locally and fails in CI
is a real problem to investigate, not noise to route around.

**Stop and ask** when a decision would be expensive to reverse and the spec does not
settle it. Otherwise choose, and record the choice with its reasoning in
`docs/decisions/`.

## Constraints that are not negotiable

1. **Nothing is required inside a user's repositories.** Studio must work against a repo
   that has never heard of it. In-repo configuration (`.wtstudio/stack.json`) is an
   optional override, never a prerequisite. Stack profiles live in Studio's own config.
2. **Agent-agnostic for real.** Every provider goes through the adapter contract in §7.
   Nothing outside `providers/` may know the string "claude". Where a provider lacks a
   capability, the UI says so rather than showing an empty state.
3. **Studio owns the world outside the conversation; the agent owns everything inside its
   repo.** No hunk staging, no commit-message composer, no PR-body authoring. If a feature
   duplicates something the agent does natively, it must justify itself by being useful
   when no session is live.
4. **Lifecycle is declared; liveness is derived.** They are separate fields, separately
   sourced, and never collapsed into one status.
5. **Never type unbounded text into a tty.** Write it to a file, source it with a short
   line, and assert the typed line stays under 1024 bytes. This was a real, silent,
   day-costing bug in v1.
6. **Full TypeScript.** The stack table in §15 is decided. Do not introduce a second
   language, an ORM, a second test runner, or SvelteKit.
7. **Write-back to external trackers is opt-in and has a dry-run mode.** It is the only
   part of this app that touches things other people can see.

## Definition of done for a phase

- Every surface it introduces renders from fixtures and appears in the gallery.
- `npm run verify` passes, and you have shown the output.
- The phase's behaviour is demonstrated against something real — a live daemon, a real
  worktree, a real session — not only against tests.
- `docs/api.md` is regenerated from the zod schemas; it is never hand-edited.
- Anything you discovered that would trip up the next phase is written down.

## Start here

Read the spec. Then propose phase 1 in detail — schema, migrations, module boundaries, the
fixture format, and the first three tests you will write — and wait for approval before
writing code.
