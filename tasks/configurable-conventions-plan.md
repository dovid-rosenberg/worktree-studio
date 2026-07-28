# Configurable conventions

Make Worktree Studio's four hardcoded personal conventions configurable, with
defaults that reproduce today's behavior byte-for-byte.

## Plan

- [ ] 1. `server/layout.js` — pure worktree-layout resolver (nested / sibling /
      external) + `nameFromPath`. Config: `worktrees: { layout, dir, root }`.
- [ ] 2. `server/identity.js` — pluggable feature-identity strategy
      (`basename` / `branch` / `manifest`), built on layout. One resolver serves
      BOTH `computeFeatures()` grouping and `featureFromPath()` slot keying so the
      two can never disagree. Config: `featureIdentity: { strategy, branchPattern, branchFlags }`.
- [ ] 3. Wire layout into `worktree.js` (dest, gitignore warning) and `git.js`
      (a linked worktree the walk stumbles on is not a repo).
- [ ] 4. Wire identity into `features.js`, `servers.js`, `state.js`,
      `orchestrator.js`, `server.js`.
- [ ] 5. copyPatterns: additive editor-agnostic defaults + make the hardcoded
      `.idea/runConfigurations` copy configurable (`copyAlways`).
- [ ] 6. Empty the accept.blue concurrency defaults; one-time migration so an
      existing install that relied on them keeps working.
- [ ] 7. Docs: `docs/config.md` + `docs/api.md` + `MANUAL.md` config table.
- [ ] 8. Tests + live server smoke test.

## Review

(filled in at the end)
