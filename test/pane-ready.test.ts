/*
 * Never type a launch command into a shell that is still starting.
 *
 * The tmux driver shells out to a real tmux, so the ordering it guarantees cannot be
 * exercised by a double the way `term.ts` or `sessions.ts` can — there is no seam. What
 * IS checkable, cheaply and exactly, is the property the fix is: every send-keys that
 * launches something is preceded by a `waitForPaneReady`.
 *
 * A source-level pin, like test/no-regression.test.ts and test/no-duplication.test.ts.
 * It exists because of how the bug came back once already: `waitForPaneReady` was added
 * to `ensure()` and `newTab()`, and then `relaunchAgent()` — a THIRD launch site, and
 * the one Resume takes — was written later and did not get it. The failure is silent
 * (the front of the command line is swallowed, the pane sits at a prompt) and the person
 * who sees it has no way to connect it to a missing call in a driver.
 *
 * `sendText()` is deliberately excluded: it types into a live claude that has already
 * been proved to be the foreground program, not into a shell coming up.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', 'server', 'multiplexer', 'tmux.ts'), 'utf8');

/** Every `send-keys` that hands the pane a launch command, by the line it sits on. */
function launchSends(src: string): number[] {
  const lines = src.split('\n');
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (!line.includes("'send-keys'")) return;
    // A launch is the one that goes through launchKeys(); the same call is also used to
    // deliver plain text, which is a different thing with a different guard.
    const window = lines.slice(i, i + 8).join('\n');
    if (window.includes('launchKeys(')) out.push(i);
  });
  return out;
}

test('every launch goes through waitForPaneReady first', () => {
  const lines = SRC.split('\n');
  const sends = launchSends(SRC);
  assert.ok(sends.length >= 3, `expected the three launch sites, found ${sends.length}`);
  for (const at of sends) {
    // The wait is the last thing before the send in every case, but "somewhere in the
    // preceding few lines" is the property that matters and the one that survives an
    // ordinary edit to the surrounding code.
    const before = lines.slice(Math.max(0, at - 14), at).join('\n');
    assert.match(
      before,
      /waitForPaneReady\(/,
      `the send-keys on line ${at + 1} launches a command into a pane nobody waited for`,
    );
  }
});

/*
 * The other half of the same fix, and the one that is pure data.
 *
 * oh-my-zsh's update prompt reads from stdin during startup, so it ate the front of the
 * launch line even after the pane looked ready — the shell WAS up, it was just asking a
 * question. These have to reach the session as `new-session -e`, because window 0 spawns
 * with that call and a later set-environment is too late for it.
 */
test('a session is created with the startup prompts already disabled', () => {
  for (const key of ['DISABLE_AUTO_UPDATE', 'DISABLE_UPDATE_PROMPT', 'ZSH_DISABLE_COMPFIX']) {
    assert.match(SRC, new RegExp(key), `${key} is what keeps the shell from asking anything`);
  }
  assert.match(SRC, /STARTUP_QUIET/, 'and they are applied as one set, not three loose strings');
});
