# Rail: recency sort, one card per session, repo hygiene (2026-11-05)

## Why

Finding a feature in the rail means scrolling. Attention sorted waiting → active → A–Z,
and "active" included any agent whose process was alive, so a session untouched for a
week sat above the idle divider in alphabetical order. Separately, one live session
(`remove-void-for-tdf`) rendered twice, and deleting from the wrong card left the
worktrees behind.

## Rail order (Attention, the default)

- [x] Server: `Session.lastPromptAt`, stamped on `UserPromptSubmit` — the moment YOU
      sent something. Not on select: clicking a row would jump it under your cursor.
- [x] Client: touch time = newest `lastPromptAt` of the row's session, else `createdAt`.
- [x] Order: waiting (pinned) → live agents by touch → dev-server-only by touch →
      idle divider → the rest by touch, newest first. Reviews stay last.
- [x] Idle: a live agent not prompted for 24h drops below the divider.
- [x] working ↔ idle flips do not move a row; only your prompts and `waiting` do.
- [x] Tests in `ui.test.ts` + a hook test for the stamp.

## One card per session

Cause: `unpromotedSessions` tested only the PRIMARY repo's `worktreePath`. A session
whose primary repo never got a worktree (ab-docs) but whose other repos did is also the
feature card's session → two rows, one selection. Deleting the session row runs
`DELETE /sessions/:id`, which kills the agent and keeps the worktrees, so the feature
card drops to idle and has to be deleted again.

- [x] Exclude any session a feature already carries (`world.featureFor`).
- [x] Regression test.

## Repo hygiene

- [x] main's CI was red since Aug 19 (format, svelte-kit sync in the wrong dir, audit) — #8.
- [x] Actions v4 → v7 folded into #8 (supersedes dependabot #1, #2).
- [ ] Dependabot #6, #7: NOT merged — they carry xterm 6, SvelteKit 3, vitest 5. Needs
      its own upgrade branch with a hands-on terminal check.
- [x] `feat/v2-spec`: deleted — studio-v2 holds the same docs, newer.
- [ ] `feat/slot-config-in-memory`: KEPT. Not superseded: main still writes the slot port
      into the frontend's src/config.js (servers.ts:663); this branch is the fix.
- [ ] Read-only code audit → report.

## Review

- Fresh worktrees: `~/.npmrc` has `ignore-scripts=true`, so neither the root
  `postinstall` nor a client `prepare` runs. Run `npm --prefix client ci` by hand; the
  client's `check`/`test` now run `svelte-kit sync` themselves.
- Sessions that existed before this change have no `lastPromptAt`, so they sort by
  `createdAt` until you next prompt them; idle ones older than a day start below the divider.
