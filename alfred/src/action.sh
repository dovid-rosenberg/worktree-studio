#!/usr/bin/env bash
# Alfred action — dispatches to Worktree Studio's API.
#
# The payload arrives as one JSON blob in $1, built by filter.sh:
#   { wtaction, path?, repo?, worktreePath?, group?, url? }
# It used to arrive as per-item workflow `variables`, which did not survive the
# hop to this script — every ⏎ POSTed an empty path and the API refused it. Env
# vars are still read as a fallback, so an older imported copy of the workflow
# keeps working, but `arg` is the channel that is actually relied on.
#
# Self-contained for the same reason filter.sh is: Alfred copies the workflow
# into its own preferences folder, so there is no path back to the checkout.
# It used to call ~/worktree-studio/swiftbar/wts-action.sh, which is a checkout
# location most installs do not have — every start/stop silently did nothing.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

CFG="${WT_STUDIO_CONFIG:-$HOME/.config/worktree-studio/config.json}"
PORT="$(jq -r '.web.port // 7788' "$CFG" 2>/dev/null || echo 7788)"
BASE="http://127.0.0.1:$PORT"
STATE_DIR="${WT_STUDIO_STATE:-$HOME/.local/state/worktree-studio}"
TOKEN="$(cat "$STATE_DIR/token" 2>/dev/null | tr -d '[:space:]')"

# Alfred closes the moment you hit return, so a failure has nowhere to be seen
# unless it becomes a notification.
notify() { osascript -e "display notification \"$1\" with title \"Worktree Studio\"" >/dev/null 2>&1; }

post() {
  local body http msg
  body="$(curl -s -m 10 -w '\n%{http_code}' -X POST "$BASE$1" \
            -H 'content-type: application/json' -H "x-wts-token: $TOKEN" -d "$2" 2>/dev/null)"
  http="$(printf '%s' "$body" | tail -n1)"
  body="$(printf '%s' "$body" | sed '$d')"
  # 200 with `{ok:false}` is a normal answer here — a failed operation is not a
  # malformed request — so the body decides, not the status alone.
  if [ "$http" = 200 ] && [ "$(printf '%s' "$body" | jq -r '.ok // true' 2>/dev/null)" = true ]; then
    return 0
  fi
  msg="$(printf '%s' "$body" | jq -r '
    .error
    // (if (.failures|type) == "array" and (.failures|length) > 0
        then "\(.started // 0)/\(.total // 0) started — " + (.failures|map("\(.repo): \(.error)")|join("; "))
        else empty end)
    // empty' 2>/dev/null)"
  [ -n "$msg" ] || msg="HTTP ${http:-no response} from the studio"
  notify "$msg"
  return 1
}

# $1 when it is the JSON blob, the environment otherwise. `field` reads one key.
PAYLOAD=""
if [ -n "${1:-}" ] && printf '%s' "$1" | jq -e 'type == "object"' >/dev/null 2>&1; then
  PAYLOAD="$1"
fi
field() {
  if [ -n "$PAYLOAD" ]; then printf '%s' "$PAYLOAD" | jq -r --arg k "$1" '.[$k] // ""'
  else eval "printf '%s' \"\${$1:-}\""; fi
}

ACTION="$(field wtaction)"; [ -n "$ACTION" ] || ACTION=open
P="$(field path)"; REPO="$(field repo)"; WTPATH="$(field worktreePath)"
GROUP="$(field group)"; URL="$(field url)"

case "$ACTION" in
  open)        [ -n "$P" ] || { notify "no path came through for this item"; exit 1; }
               post /api/open           "$(jq -nc --arg p "$P" '{path:$p}')" ;;
  finder)      [ -n "$P" ] && /usr/bin/open -R "$P" ;;
  url)         [ -n "$URL" ] && /usr/bin/open "$URL" ;;
  start)       post /api/servers/start  "$(jq -nc --arg r "$REPO" --arg p "$WTPATH" '{repo:$r,worktreePath:$p}')" ;;
  stop)        post /api/servers/stop   "$(jq -nc --arg r "$REPO" --arg p "$WTPATH" '{repo:$r,worktreePath:$p}')" ;;
  group-start) post /api/group/start    "$(jq -nc --arg g "$GROUP" '{group:$g,stopConflicts:true}')" ;;
  group-stop)  post /api/group/stop     "$(jq -nc --arg g "$GROUP" '{group:$g}')" ;;
  *)           notify "unknown action: $ACTION" ; exit 1 ;;
esac
