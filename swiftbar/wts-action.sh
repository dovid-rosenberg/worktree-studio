#!/usr/bin/env bash
# Action helper for the SwiftBar plugin + Alfred. POSTs to the studio API.
#   wts-action.sh group-start|group-stop|group-restart <feature>
#   wts-action.sh server-start|server-stop <repo> <worktreePath>
#   wts-action.sh popout <sessionId>
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
CFG="${WT_STUDIO_CONFIG:-$HOME/.config/worktree-studio/config.json}"
PORT="$(jq -r '.web.port // 7788' "$CFG" 2>/dev/null || echo 7788)"
BASE="http://127.0.0.1:$PORT"
STATE_DIR="${WT_STUDIO_STATE:-$HOME/.local/state/worktree-studio}"
TOKEN="$(tr -d '[:space:]' <"$STATE_DIR/token" 2>/dev/null)"
post() { curl -s -m 10 -X POST "$BASE$1" -H 'content-type: application/json' -H "x-wts-token: $TOKEN" -d "$2" >/dev/null 2>&1; }

case "$1" in
  group-start)   post /api/group/start   "$(jq -nc --arg g "$2" '{group:$g,stopConflicts:true}')" ;;
  group-stop)    post /api/group/stop     "$(jq -nc --arg g "$2" '{group:$g}')" ;;
  group-restart) post /api/group/restart  "$(jq -nc --arg g "$2" '{group:$g}')" ;;
  server-start)  post /api/servers/start  "$(jq -nc --arg r "$2" --arg p "$3" '{repo:$r,worktreePath:$p}')" ;;
  server-stop)   post /api/servers/stop    "$(jq -nc --arg r "$2" --arg p "$3" '{repo:$r,worktreePath:$p}')" ;;
  popout)        post "/api/sessions/$2/popout" '{}' ;;
  *) echo "unknown action: $1" >&2; exit 1 ;;
esac
