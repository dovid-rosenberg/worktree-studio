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
