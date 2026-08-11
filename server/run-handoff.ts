/*
 * Handing a failed run to the agent that can fix it.
 *
 * The Runs tab already knows the command, the exit code and where the output is; the
 * agent is one tab away. Closing that gap by hand means selecting a wall of stack trace,
 * copying it, switching tabs and pasting — the most repeated manual step in the whole
 * workflow, and the one most likely to arrive truncated.
 *
 * ONE LINE, POINTING AT THE LOG. Not the output itself.
 *
 * `sendText` writes the body into the pane literally and then presses Enter separately
 * (multiplexer/tmux.ts). A body containing newlines therefore submits at the FIRST one,
 * so a pasted stack trace would arrive as fifty half-messages, each one interrupting the
 * agent again. Every existing injection — `/add-dir`, `/cd` — is a single line for the
 * same reason.
 *
 * Pointing at the file is better than pasting anyway: the run log is already on disk, the
 * agent has a tool to read it, and it reads ALL of it rather than whatever tail we
 * guessed was enough. The message carries the facts that are NOT in the log — which
 * configuration this was, what it exited with, and which worktree it ran in.
 */
import type { Run } from './types.ts';

/** The one-line prompt, kept out of the route so a test can assert on the words. */
export function handoffMessage(run: Run): string {
  const what = run.status === 'stopped' ? 'was stopped' : 'failed';
  const code = run.exitCode == null ? '' : ` with exit code ${run.exitCode}`;
  return (
    `The run "${run.name}" ${what}${code}. ` +
    `It ran \`${run.cmd}\` in ${run.worktreePath}. ` +
    `Its full output is at ${run.log} — please read that file, work out why it ${what}, and fix it.`
  );
}

/** Why a handoff could not happen, in words a toast can show unchanged. */
export const NO_RUN = 'no such run';
export const STILL_RUNNING = 'that run is still going — wait for it to finish';
export const NO_SESSION = 'no agent is attached to that worktree';

export interface HandoffDeps {
  getRun(id: string): Run | undefined;
  /** The session owning a worktree, or null — SessionManager.sessionForWorktree. */
  sessionFor(worktreePath: string): { id: string; muxName: string } | null;
  /** SessionManager.sendWhenReady — already gated on claude being up and not mid-turn. */
  send(
    muxName: string,
    text: string,
    session?: unknown,
  ): Promise<{ ok: boolean; skipped?: boolean; reason?: string }>;
}

export interface HandoffResult {
  ok: boolean;
  error?: string;
  /** The agent is there but was not ready — the caller says so rather than claiming success. */
  skipped?: boolean;
  reason?: string;
  sessionId?: string;
  message?: string;
}

export async function handoff(deps: HandoffDeps, runId: string): Promise<HandoffResult> {
  const run = deps.getRun(runId);
  if (!run) return { ok: false, error: NO_RUN };
  // A run still going has no verdict to explain, and its log is still being written.
  if (run.status === 'running') return { ok: false, error: STILL_RUNNING };

  const session = deps.sessionFor(run.worktreePath);
  if (!session) return { ok: false, error: NO_SESSION };

  const message = handoffMessage(run);
  const sent = await deps.send(session.muxName, message, session);
  // `sendWhenReady` answers `{ok:false, skipped:true}` when claude never came up, and
  // flags the session itself. Passed through rather than flattened to a failure: nothing
  // went wrong, the agent simply is not listening yet.
  if (!sent.ok) {
    return { ok: false, skipped: sent.skipped, reason: sent.reason, sessionId: session.id, message };
  }
  return { ok: true, sessionId: session.id, message };
}
