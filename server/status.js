'use strict';
// Claude Code hook integration. Generates a per-session `--settings` file whose
// hooks POST lifecycle events to this server, and maps those events onto a
// session state (working / waiting / idle / stopped). No global settings touched.
const fs = require('fs');
const path = require('path');

const REPORT = path.join(__dirname, '..', 'hooks', 'report.sh');

// event → { state, activity? }
function mapEvent(event, payload) {
  const tool = payload && (payload.tool_name || payload.toolName);
  switch (event) {
    case 'SessionStart': return { state: 'idle', activity: 'session started' };
    case 'UserPromptSubmit': return { state: 'working', activity: 'thinking…' };
    case 'PreToolUse': return { state: 'working', activity: tool ? `running ${tool}` : 'working…' };
    case 'PostToolUse': return { state: 'working', activity: tool ? `${tool} done` : 'working…' };
    case 'Notification': return { state: 'waiting', activity: (payload && payload.message) || 'waiting for you' };
    case 'Stop': return { state: 'idle', activity: 'turn done' };
    case 'SubagentStop': return { state: 'working', activity: 'subagent done' };
    case 'SessionEnd': return { state: 'stopped', activity: 'session ended' };
    default: return null;
  }
}

// Build the settings JSON for a studio session; hooks curl back with ?wts=<id>.
function buildSettings(studioId, port) {
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'];
  const hooks = {};
  for (const ev of events) {
    const url = `http://127.0.0.1:${port}/hook/${ev}?wts=${encodeURIComponent(studioId)}`;
    hooks[ev] = [{ hooks: [{ type: 'command', command: `${REPORT} ${JSON.stringify(url)}`, timeout: 5 }] }];
  }
  return { hooks };
}

function settingsFile(stateDir, studioId, port) {
  const dir = path.join(stateDir, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${studioId}.settings.json`);
  fs.writeFileSync(f, JSON.stringify(buildSettings(studioId, port), null, 2));
  return f;
}

module.exports = { mapEvent, buildSettings, settingsFile };
