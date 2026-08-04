// Claude Code hook integration. Generates a per-session `--settings` file whose
// hooks POST lifecycle events to this server, and maps those events onto a
// session state (working / waiting / idle / stopped). No global settings touched.
import fs from 'fs';
import path from 'path';
import type { SessionState } from './types.ts';

const REPORT = path.join(import.meta.dirname, '..', 'hooks', 'report.sh');

/** A hook's POSTed body. Only these keys are read; the rest of the event rides along. */
interface HookPayload {
  tool_name?: string;
  toolName?: string;
  message?: string;
  [key: string]: unknown;
}

/** What one lifecycle event says about the session. */
interface EventState {
  state: SessionState;
  activity: string;
}

/** One entry of a Claude Code settings file's `hooks` block. */
interface HookMatcher {
  hooks: Array<{ type: string; command: string; timeout: number }>;
}

interface HookSettings {
  hooks: Record<string, HookMatcher[]>;
}

// event → { state, activity? }
function mapEvent(event: string, payload?: HookPayload | null): EventState | null {
  const tool = payload && (payload.tool_name || payload.toolName);
  switch (event) {
    case 'SessionStart':
      return { state: 'idle', activity: 'session started' };
    case 'UserPromptSubmit':
      return { state: 'working', activity: 'thinking…' };
    case 'PreToolUse':
      return { state: 'working', activity: tool ? `running ${tool}` : 'working…' };
    case 'PostToolUse':
      return { state: 'working', activity: tool ? `${tool} done` : 'working…' };
    case 'Notification':
      return { state: 'waiting', activity: payload?.message || 'waiting for you' };
    case 'Stop':
      return { state: 'idle', activity: 'turn done' };
    case 'SubagentStop':
      return { state: 'working', activity: 'subagent done' };
    case 'SessionEnd':
      return { state: 'stopped', activity: 'session ended' };
    default:
      return null;
  }
}

// Build the settings JSON for a studio session; hooks curl back with ?wts=<id>.
// The boot token rides in the query string because that URL is all the hook script
// gets — it cannot be handed a header. The file now holds a secret, so it and its
// directory are written 0600/0700; only the session's own claude process reads it.
function buildSettings(studioId: string, port: number, token?: string): HookSettings {
  const events = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Notification',
    'Stop',
    'SubagentStop',
    'SessionEnd',
  ];
  const hooks: Record<string, HookMatcher[]> = {};
  const auth = token ? `&token=${encodeURIComponent(token)}` : '';
  for (const ev of events) {
    const url = `http://127.0.0.1:${port}/hook/${ev}?wts=${encodeURIComponent(studioId)}${auth}`;
    hooks[ev] = [{ hooks: [{ type: 'command', command: `${REPORT} ${JSON.stringify(url)}`, timeout: 5 }] }];
  }
  return { hooks };
}

function settingsFile(stateDir: string, studioId: string, port: number, token?: string): string {
  const dir = path.join(stateDir, 'hooks');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, `${studioId}.settings.json`);
  fs.writeFileSync(f, JSON.stringify(buildSettings(studioId, port, token), null, 2), { mode: 0o600 });
  // `mode` only applies when the file is created — chmod so files written by an
  // older build (which now hold a token) get tightened too.
  try {
    fs.chmodSync(f, 0o600);
  } catch {
    /* best effort */
  }
  return f;
}

export { mapEvent, buildSettings, settingsFile };
export type { HookPayload, EventState, HookSettings };
