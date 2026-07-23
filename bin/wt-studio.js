#!/usr/bin/env node
// Worktree Studio launcher + small CLI.
//   wt-studio                 → start the server
//   wt-studio add-repo <repo> → add a repo to THIS session's feature
//                               (reads $WT_STUDIO_SESSION; for claude to call)
const path = require('path');
const fs = require('fs');
const os = require('os');

const [, , cmd, ...args] = process.argv;

if (cmd === 'add-repo') {
  const repo = args[0];
  const sessionId = process.env.WT_STUDIO_SESSION;
  if (!repo) { console.error('usage: wt-studio add-repo <repo>'); process.exit(1); }
  if (!sessionId) { console.error('WT_STUDIO_SESSION not set — run this from inside a Worktree Studio session'); process.exit(1); }
  const cfgFile = process.env.WT_STUDIO_CONFIG || path.join(os.homedir(), '.config', 'worktree-studio', 'config.json');
  let port = 7788;
  try { port = (JSON.parse(fs.readFileSync(cfgFile, 'utf8')).web || {}).port || 7788; } catch { /* */ }
  const body = JSON.stringify({ repo });
  fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/add-repo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) { console.error(`add-repo failed: ${data.error || r.statusText}`); process.exit(1); }
    const wt = data.worktree ? data.worktree.path : '(already added)';
    console.log(`Added ${repo} to this feature → ${wt}\nYou now have access to it (via /add-dir). Do that repo's changes in the worktree above.`);
  }).catch((e) => { console.error(`add-repo error: ${e.message}`); process.exit(1); });
} else {
  require('../server/server.js');
}
