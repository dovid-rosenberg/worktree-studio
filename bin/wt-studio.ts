#!/usr/bin/env node
// Worktree Studio launcher + small CLI.
//   wt-studio                 → start the server
//   wt-studio add-repo <repo> → add a repo to THIS session's feature
//                               (reads $WT_STUDIO_SESSION; for claude to call)
import path from 'path';
import fs from 'fs';
import os from 'os';

/** The slice of POST /sessions/:id/add-repo's answer this CLI prints. */
interface AddRepoResponse {
  ok?: boolean;
  error?: string;
  worktree?: { path: string };
}

const [, , cmd, ...args] = process.argv;

if (cmd === 'add-repo') {
  const repo = args[0];
  const sessionId = process.env.WT_STUDIO_SESSION;
  if (!repo) {
    console.error('usage: wt-studio add-repo <repo>');
    process.exit(1);
  }
  if (!sessionId) {
    console.error('WT_STUDIO_SESSION not set — run this from inside a Worktree Studio session');
    process.exit(1);
  }
  const cfgFile =
    process.env.WT_STUDIO_CONFIG || path.join(os.homedir(), '.config', 'worktree-studio', 'config.json');
  let port = 7788;
  try {
    port = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).web?.port || 7788;
  } catch {
    /* */
  }
  // The boot token lives in the state dir (mode 0600) — same place the server wrote
  // it. Reading it is the proof that we're a process of the user who owns the studio.
  const stateDir =
    process.env.WT_STUDIO_STATE || path.join(os.homedir(), '.local', 'state', 'worktree-studio');
  let token = '';
  try {
    token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  } catch {
    /* */
  }
  if (!token) {
    console.error(`no studio token at ${path.join(stateDir, 'token')} — is the server running?`);
    process.exit(1);
  }
  const body = JSON.stringify({ repo });
  fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/add-repo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wts-token': token },
    body,
  })
    .then(async (r) => {
      const data = (await r.json().catch(() => ({}))) as AddRepoResponse;
      if (!r.ok || data.ok === false) {
        console.error(`add-repo failed: ${data.error || r.statusText}`);
        process.exit(1);
      }
      const wt = data.worktree ? data.worktree.path : '(already added)';
      console.log(
        `Added ${repo} to this feature → ${wt}\nYou now have access to it (via /add-dir). Do that repo's changes in the worktree above.`,
      );
    })
    .catch((e: unknown) => {
      console.error(`add-repo error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
} else {
  // A dynamic import, not a static one: this branch is the ONLY thing that may boot
  // the daemon, and a static import at the top would run main() for `add-repo` too.
  await import('../server/server.ts');
}
