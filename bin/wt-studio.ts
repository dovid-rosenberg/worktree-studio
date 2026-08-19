#!/usr/bin/env node
// Worktree Studio launcher + small CLI.
//   wt-studio                 → start the server
//   wt-studio add-repo <repo> → add a repo to THIS session's feature
//                               (reads $WT_STUDIO_SESSION; for claude to call)
//   wt-studio endpoint        → print the API base URL and boot token, shell-eval ready
//
// Where any of that LIVES is server/paths.ts's answer, not this file's. This module used
// to re-derive the config path, the 7788 default and the token location itself, which is
// the copy the four shell integrations then copied again.
import { baseUrl, readToken, tokenFile } from '../server/paths.ts';

/** The slice of POST /sessions/:id/add-repo's answer this CLI prints. */
interface AddRepoResponse {
  ok?: boolean;
  error?: string;
  worktree?: { path: string };
}

const [, , cmd, ...args] = process.argv;

/**
 * The token, or a refusal that says where it looked.
 *
 * No token means no daemon: security.ts writes the file at boot and leaves it there, so
 * its absence is the one diagnosis worth printing rather than letting the request fail
 * as a connection error.
 */
function tokenOrExit(): string {
  const token = readToken();
  if (!token) {
    console.error(`no studio token at ${tokenFile()} — is the server running?`);
    process.exit(1);
  }
  return token;
}

if (cmd === 'endpoint') {
  /*
   * Everything a shell integration needs to call the API, so it stops parsing config.json
   * with jq to work it out. Emitted as assignments rather than two bare lines so it can be
   * consumed without positional guessing:
   *
   *   eval "$(wt-studio endpoint)"
   *   curl -H "x-wts-token: $WT_STUDIO_TOKEN" "$WT_STUDIO_BASE/api/state"
   *
   * Single-quoted, with any embedded quote escaped the POSIX way — the token is hex today,
   * but a value that reaches `eval` is not the place to rely on that staying true.
   */
  const sh = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;
  const token = tokenOrExit();
  console.log(`WT_STUDIO_BASE=${sh(baseUrl())}`);
  console.log(`WT_STUDIO_TOKEN=${sh(token)}`);
} else if (cmd === 'add-repo') {
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
  // The boot token lives in the state dir (mode 0600) — same place the server wrote
  // it. Reading it is the proof that we're a process of the user who owns the studio.
  const token = tokenOrExit();
  const body = JSON.stringify({ repo });
  fetch(`${baseUrl()}/api/sessions/${sessionId}/add-repo`, {
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
  // server/paths.ts above is safe to import statically precisely because it does nothing
  // at import time — see its header.
  await import('../server/server.ts');
}
