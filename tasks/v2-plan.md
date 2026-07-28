# Worktree Studio — v2 build-out

Integration branch: `studio-v2` (off `main`). Every workstream branches off it and
merges back into it. `studio-v2` → `main` only on David's say-so.

Worktrees live under `.worktrees/`, created with `wt` (never `git worktree add`) and
excluded locally via `.git/info/exclude` so they can't be swept into a commit.

## Status — 7 of 12 merged, 320 tests passing

| Branch | State |
|---|---|
| `refactor/server-modules` | ✅ merged — `server.js` 797→512, 44 routes verified identical, `docs/api.md` |
| `feat/transcript-telemetry` | ✅ merged — FTS5 search + cost telemetry |
| `feat/diff-hunks-server` | ✅ merged — structured diff model + hunk staging |
| `feat/sveltekit-foundation` | ✅ merged — SPA scaffold, tokens, `Terminal.svelte` |
| `feat/security-hardening` | ✅ merged — Origin/Host allowlist, boot token, UUID ids |
| `perf/state-broadcast` | ✅ merged — realpath index, split topology/session-state SSE |
| `perf/fs-watching` | ✅ merged — `fs.watch` on git internals, attention-paced sweep |
| `feat/ci-push` | ⏳ running |
| `feat/sveltekit-app` | ⏳ running — the shell |
| `feat/sveltekit-review` | ⏳ running — Changes panel |
| `feat/sveltekit-insights` | ⏳ running — search + telemetry UI |
| `feat/configurable-conventions` | ⏳ running — flexibility items 1, 2, 4, 5 |

## Decisions

- **Review model: commit-centric AND staging.** Changes tab = commit list (`base..HEAD`)
  plus an "uncommitted" entry. Side-by-side applies to both. File-level *and* hunk-level
  staging on the uncommitted entry. Both, not one replacing the other.
- **Transcript search: Studio-managed sessions only**, keyed off `claudeSessionId`.
- **SvelteKit `adapter-static` (SPA, `ssr = false`)** served by the Express daemon.
  SvelteKit does not become the server.
- **Cost is derived**, from a local price table that goes stale. Labelled an estimate
  everywhere; unpriced models render "unpriced", never `$0.00`.
- **`node:sqlite`** for the index (zero new deps). `engines.node` → `>=22`.
- **Platform adapter (Linux) skipped** — on macOS it replaces nothing; pure audience
  expansion with no benefit to the only current user.
- No app packaging, no remote access. Deferred by request.

## Findings worth keeping

- **Claude Code repeats identical `message.usage` on every content-block line.**
  Measured 3.00× output-token overcount on a live transcript (166 assistant lines,
  59 unique `message.id`). Dedupe on `message.id`; this also makes reindexing idempotent.
- **Hunk staging must diff against the *index*** (`git diff` to stage, `git diff --cached`
  to unstage), not `git diff HEAD` — that is why partially-staged files work.
- **`muxName` truncation bug**: `` `wts-${name}-${id.slice(2)}`.slice(0,60) `` with a
  48-char feature slug ate the id tail, so every session of a long-named feature would
  have collided on one tmux name. Introduced-by-UUIDs, caught by a regression test.
- **SSE stitching trap**: the payload embeds `{id,state,activity,muxName}` into worktree
  rows *and* carries the authoritative `sessions` list. Patching one merged `state` object
  in place lets a `topology` frame erase session decoration. Keep both halves verbatim and
  derive. Documented in `docs/api.md`.
- **`hasViewers` must count pollers, not just SSE.** SwiftBar and Alfred use plain
  `curl /api/state`; gating on `sseClients.size` alone made the menubar up to 116s stale.
- Pre-existing `public/app.js` bugs found while porting: `toggleTheme()` never re-themed
  the split pane; `connectSecondWS` had no reconnect; the first theme toggle was a no-op
  on a light-themed OS.

## Bugs found and deliberately NOT fixed (out of scope)

1. `/api/group/pr` reports only the *last* provider's stderr — gh's real failure reason is
   discarded when glab isn't installed.
2. `/api/group/pr` ignores `git push` failures and proceeds to PR creation.
3. `/api/group/start` returns `ok: true` even when every member failed.
4. Slot-reclaim race: `reconcileSlots()` can drop a slot while `servers.start()` is still
   waiting for ports to bind, handing it to another feature → port collision.

## Remaining after the branches land

- Merge the four UI/server branches; resolve `client/` mount points for review + insights.
- **Cutover**: `public/` → `client/build` is one line in `server.js`, but it is a discrete
  switch — both dirs have an `index.html`, so whichever registers first wins `/`. Needs the
  SPA fallback route and a decision on how the static build receives the boot token.
- Update `MANUAL.md` for the new config keys and the auth model.
