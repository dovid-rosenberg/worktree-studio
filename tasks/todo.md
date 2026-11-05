# Rail: recency sort, one card per session, repo hygiene (2026-11-05)

## Why

Finding a feature in the rail means scrolling. Attention sorted waiting → active → A–Z,
and "active" included any agent whose process was alive, so a session untouched for a
week sat above the idle divider in alphabetical order. Separately, one live session
(`remove-void-for-tdf`) rendered twice, and deleting from the wrong card left the
worktrees behind.

## Rail order (Attention, the default)

- [ ] Server: `Session.lastPromptAt`, stamped on `UserPromptSubmit` — the moment YOU
      sent something. Not on select: clicking a row would jump it under your cursor.
- [ ] Client: touch time = newest `lastPromptAt` of the row's session, else `createdAt`.
- [ ] Order: waiting (pinned) → live agents by touch → dev-server-only by touch →
      idle divider → the rest by touch, newest first. Reviews stay last.
- [ ] Idle: a live agent not prompted for 24h drops below the divider.
- [ ] working ↔ idle flips do not move a row; only your prompts and `waiting` do.
- [ ] Tests in `ui.test.ts` + a hook test for the stamp.

## One card per session

Cause: `unpromotedSessions` tested only the PRIMARY repo's `worktreePath`. A session
whose primary repo never got a worktree (ab-docs) but whose other repos did is also the
feature card's session → two rows, one selection. Deleting the session row runs
`DELETE /sessions/:id`, which kills the agent and keeps the worktrees, so the feature
card drops to idle and has to be deleted again.

- [ ] Exclude any session a feature already carries (`world.featureFor`).
- [ ] Regression test.

## Repo hygiene

- [ ] Merge dependabot PRs (#1, #2 actions; #6, #7 deps) — verify each first.
- [ ] `feat/v2-spec`: docs-only, merge into main.
- [ ] `feat/slot-config-in-memory`: superseded (Studio no longer launches the vite
      override) — delete local + remote.
- [ ] Read-only code audit (dead code, unused deps, bloat) → report, act on approval.

## Review
