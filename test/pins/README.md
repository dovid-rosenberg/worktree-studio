# Structural pins

These are not behavioural tests. They read the source as text and assert that a rule the
codebase has already broken once is still written down — a call that must precede another
call, a constant that must exist in exactly one file.

They are here because the failures they guard are invisible at runtime in the place they
happen: a launch command swallowed by a shell that was still starting looks like "claude
didn't come up", and a second copy of a rule looks like nothing at all until the copies
disagree months later. A grep fails at the moment someone writes the mistake, which is the
only cheap moment.

What a pin does NOT do is check that the code works. `pane-ready.test.ts` asserts that
`waitForPaneReady(` appears above every launching `send-keys`; it would pass just as
happily if that function returned immediately. The behaviour belongs to tests that drive a
real tmux — `test/tmux-integration.test.ts` — and a pin is never a reason to skip writing
one. Treat a pin as a comment the build enforces.

They also cost something: they break on ordinary refactors that changed nothing real
(renaming a helper, moving a call five lines further up). When one fails, read what it says
the rule is before rewriting the assertion — if the rule still holds, fix the code; if the
rule genuinely no longer applies, delete the pin and say why in the commit.
