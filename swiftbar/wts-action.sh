#!/usr/bin/env bash
# Action helper for the SwiftBar plugin + Alfred. POSTs to the studio API.
#   wts-action.sh group-start|group-stop|group-restart|group-open <feature>
#   wts-action.sh server-start|server-stop <repo> <worktreePath>
#   wts-action.sh open <path>
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
CFG="${WT_STUDIO_CONFIG:-$HOME/.config/worktree-studio/config.json}"
PORT="$(jq -r '.web.port // 7788' "$CFG" 2>/dev/null || echo 7788)"
BASE="http://127.0.0.1:$PORT"
STATE_DIR="${WT_STUDIO_STATE:-$HOME/.local/state/worktree-studio}"
TOKEN="$(cat "$STATE_DIR/token" 2>/dev/null | tr -d '[:space:]')"

# Report what the API said. Callers are menubar clicks and Alfred actions: there
# is no console to read, so a failure has to arrive as a notification or it is
# indistinguishable from success. `{ok:false}` with HTTP 200 is a normal answer
# here (a failed operation is not a malformed request), so check the body too.
post() {
  local body http
  body="$(curl -s -m 10 -w '\n%{http_code}' -X POST "$BASE$1" \
            -H 'content-type: application/json' -H "x-wts-token: $TOKEN" -d "$2" 2>/dev/null)"
  http="$(printf '%s' "$body" | tail -n1)"
  body="$(printf '%s' "$body" | sed '$d')"
  if [ "$http" = 200 ] && [ "$(printf '%s' "$body" | jq -r '.ok // true' 2>/dev/null)" = true ]; then
    return 0
  fi
  local msg
  # A partial group start reports per-member `failures` and no top-level `error`,
  # so "started 2 of 3, and here is why the third didn't" needs its own branch.
  msg="$(printf '%s' "$body" | jq -r '
    .error
    // (if (.failures|type) == "array" and (.failures|length) > 0
        then "\(.started // 0)/\(.total // 0) started — " + (.failures|map("\(.repo): \(.error)")|join("; "))
        else empty end)
    // empty' 2>/dev/null)"
  [ -n "$msg" ] || msg="HTTP ${http:-no response}"
  osascript -e "display notification \"$msg\" with title \"Worktree Studio\"" >/dev/null 2>&1
  echo "worktree-studio: $msg" >&2
  return 1
}

case "$1" in
  group-start)   post /api/group/start   "$(jq -nc --arg g "$2" '{group:$g,stopConflicts:true}')" ;;
  group-stop)    post /api/group/stop    "$(jq -nc --arg g "$2" '{group:$g}')" ;;
  group-restart) post /api/group/restart "$(jq -nc --arg g "$2" '{group:$g}')" ;;
  group-open)    post /api/group/open    "$(jq -nc --arg g "$2" '{group:$g}')" ;;
  server-start)  post /api/servers/start "$(jq -nc --arg r "$2" --arg p "$3" '{repo:$r,worktreePath:$p}')" ;;
  server-stop)   post /api/servers/stop  "$(jq -nc --arg r "$2" --arg p "$3" '{repo:$r,worktreePath:$p}')" ;;
  open)          post /api/open          "$(jq -nc --arg p "$2" '{path:$p}')" ;;
  *) echo "unknown action: $1" >&2; exit 1 ;;
esac
