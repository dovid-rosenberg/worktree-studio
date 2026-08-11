# Lessons

## A pasted error may be the payload, not the bug (2026-07-28)

**Pattern:** David reported "stuck creating a new session" and pasted a JS
`Failed to construct 'URL'` stack trace. I started debugging that stack trace. It
was not from this app at all — it was the *text he had typed into the new-session
freetext box*, which then rode along as the launch command's seed argument. The
actual failure was visible only in the screenshot: the pane sitting at zsh's
`quote>` continuation prompt.

**Rule:** before debugging a pasted error, establish that it came from *this*
system. Check the file names in the trace against the repo's build output. If they
don't match, ask what the user is looking at rather than reverse-engineering a
foreign bundle.

## tmux send-keys silently truncates at 1024 bytes (2026-07-28)

**Pattern:** `server/multiplexer/tmux.ts` typed the whole claude launch command
into the pane with `send-keys`. That command embeds the user's seed and the
system-prompt note inline, so it routinely exceeds 1024 characters. A shell that
hasn't finished starting still has its tty in **canonical mode**, where the kernel
drops everything past `MAX_INPUT` (1024 on macOS) of an unterminated line. The cut
landed mid-single-quote, so zsh sat at `quote>` forever. Nothing errored: tmux
delivered the keys, the kernel threw them away.

**Rule:** never type unbounded text into a tty. Write it to a file and send a short
`. <file>`. Fixed in `launchKeys()`; regression test in `test/tmux-launch.test.ts`
asserts the typed line stays under 1024 bytes. Note the trap only fires when the
receiving shell is slow to reach raw mode — a `zsh -f` repro will pass while a real
login shell with a heavy rc hangs.

## Never work in this repo's main checkout (2026-08-06)

**Pattern:** while fixing the `can't find session` reconnect loop directly in
`/Users/davidr/Desktop/code/worktree-studio`, a *second* Claude session working in
the same checkout ran a blanket `git add` and committed my half-finished edits under
its own unrelated message (`0f23b28`, about run configs) — capturing them mid-edit,
before a broken import was fixed. It then switched the checkout to `feat/run-panel`
while my tests were still running, and pushed to `main`. Symptoms that looked
inexplicable at the time: `git status` clean with my changes nowhere in the diff, a
`svelte-check` error in `ActionBar.svelte` I had never touched that vanished on the
next run, and a `node --test` run that hung for 21 minutes and then passed in 19
seconds when re-run.

**Rule:** before editing anything in this repo, `git branch --show-current` and
`git status`. If the tree is dirty or on someone else's branch, stop and create a
worktree with `wt <branch> <name>` — never work in the main checkout. Studio itself
starts every un-promoted session with `cwd: repoPath`, so *any* two sessions in one
repo share that directory; assume another agent is in there. A test suite that hangs
or a diff that disappears is this, not a bug in the code under test. The structural
fix is planned as Phase 1 in `tasks/todo.md` (checkout lease).
