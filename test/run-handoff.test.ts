/*
 * Handing a failed run to the agent (server/run-handoff.ts).
 *
 * The design is shaped by one constraint, and the test that matters most is the one that
 * pins it: `sendText` writes the body into the pane literally and then presses Enter
 * SEPARATELY, so a body containing a newline submits at the first one. Pasting a stack
 * trace would arrive as fifty half-messages, each interrupting the agent again.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { handoff, handoffMessage, NO_RUN, NO_SESSION, STILL_RUNNING } from '../server/run-handoff.ts';
import type { Run } from '../server/types.ts';

const run = (over: Partial<Run> = {}): Run =>
  ({
    id: 'r1',
    name: 'Unit tests',
    repo: 'accept-blue',
    worktreePath: '/code/accept-blue/.worktrees/mfa',
    cmd: 'npm run test:unit',
    status: 'failed',
    startedAt: 1,
    endedAt: 2,
    exitCode: 1,
    log: '/state/runs/accept-blue-unit-tests-r1.log',
    ...over,
  }) as Run;

/** A manager stand-in that records what was typed into the pane. */
function deps(over: Partial<Parameters<typeof handoff>[0]> = {}, r: Run | undefined = run()) {
  const sent: string[] = [];
  const base = {
    getRun: () => r,
    sessionFor: () => ({ id: 's1', muxName: 'wts-mfa-0001' }),
    send: async (_m: string, text: string) => {
      sent.push(text);
      return { ok: true };
    },
  };
  return { d: { ...base, ...over }, sent };
}

test('the message is ONE line — a newline would submit it half-written', async () => {
  /*
   * THE CONSTRAINT. multiplexer/tmux.ts sends the body with `send-keys -l` and then a
   * separate `Enter`, so every newline inside the body is itself a submit. This is why
   * the handoff points at the log rather than pasting it, and why no future version of
   * this message may grow a line break.
   */
  const msg = handoffMessage(run());
  assert.ok(!msg.includes('\n'), 'the body must never contain a newline');
  assert.ok(!msg.includes('\r'), 'nor a carriage return');
});

test('it says what failed, how, where, and where the output is', async () => {
  const msg = handoffMessage(run());
  assert.match(msg, /"Unit tests"/, 'names the configuration');
  assert.match(msg, /exit code 1/, 'gives the verdict');
  assert.match(msg, /npm run test:unit/, 'gives the command');
  assert.match(msg, /\/code\/accept-blue\/\.worktrees\/mfa/, 'gives the worktree');
  // The point of the whole design: the agent reads ALL the output, not the tail someone
  // guessed was enough.
  assert.match(msg, /\/state\/runs\/accept-blue-unit-tests-r1\.log/, 'points at the log file');
});

test('a stopped run is described as stopped, not as a failure', async () => {
  const msg = handoffMessage(run({ status: 'stopped', exitCode: null }));
  assert.match(msg, /was stopped/);
  assert.ok(!/exit code/.test(msg), 'a killed run has no exit code worth quoting');
});

test('sends to the agent that owns the run’s worktree', async () => {
  const { d, sent } = deps();
  const out = await handoff(d, 'r1');
  assert.equal(out.ok, true);
  assert.equal(out.sessionId, 's1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0], handoffMessage(run()));
});

test('refuses a run that is still going', async () => {
  const { d, sent } = deps({}, run({ status: 'running', endedAt: undefined, exitCode: undefined }));
  const out = await handoff(d, 'r1');
  assert.equal(out.ok, false);
  assert.equal(out.error, STILL_RUNNING);
  assert.equal(sent.length, 0, 'nothing typed into anybody’s pane');
});

test('refuses a run whose worktree has no agent', async () => {
  const { d, sent } = deps({ sessionFor: () => null });
  const out = await handoff(d, 'r1');
  assert.equal(out.ok, false);
  assert.equal(out.error, NO_SESSION);
  assert.equal(sent.length, 0);
});

test('refuses an id that names nothing', async () => {
  const { d } = deps({ getRun: () => undefined });
  assert.equal((await handoff(d, 'nope')).error, NO_RUN);
});

test('reports "not ready" as skipped, not as a failure', async () => {
  /*
   * `sendWhenReady` answers `{ok:false, skipped:true}` when claude never came to the
   * foreground — the agent exists, it simply was not listening. Flattening that into an
   * error would tell the user the button is broken when the truthful answer is "try again
   * in a second".
   */
  const { d } = deps({ send: async () => ({ ok: false, skipped: true, reason: 'no-claude' }) });
  const out = await handoff(d, 'r1');
  assert.equal(out.ok, false);
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'no-claude');
  assert.ok(out.message, 'the message it would have sent is still reported');
});
