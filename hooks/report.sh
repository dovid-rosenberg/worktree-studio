#!/usr/bin/env bash
# Claude Code hook → Worktree Studio status reporter.
# Reads the hook JSON on stdin and POSTs it to the studio server. Best-effort:
# never blocks or fails the session, even if the server is down.
url="$1"
payload="$(cat)"
curl -s -m 2 -X POST "$url" -H 'content-type: application/json' --data-binary "$payload" >/dev/null 2>&1 || true
exit 0
