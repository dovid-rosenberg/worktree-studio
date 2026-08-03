#!/usr/bin/env bash
# Alfred action — dispatches to Worktree Studio's API based on $wtaction.
# Env from the Script Filter: wtaction, path, repo, worktreePath, sessionId.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
CFG="${WT_STUDIO_CONFIG:-$HOME/.config/worktree-studio/config.json}"
PORT="$(jq -r '.web.port // 7788' "$CFG" 2>/dev/null || echo 7788)"
BASE="http://127.0.0.1:$PORT"
ACT="$HOME/worktree-studio/swiftbar/wts-action.sh"
STATE_DIR="${WT_STUDIO_STATE:-$HOME/.local/state/worktree-studio}"
TOKEN="$(cat "$STATE_DIR/token" 2>/dev/null | tr -d '[:space:]')"

case "${wtaction:-open}" in
  open)   curl -s -X POST "$BASE/api/open" -H 'content-type: application/json' -H "x-wts-token: $TOKEN" -d "$(jq -nc --arg p "$path" '{path:$p}')" >/dev/null ;;
  finder) /usr/bin/open "$path" ;;
  start)  "$ACT" server-start "$repo" "$worktreePath" ;;
  stop)   "$ACT" server-stop  "$repo" "$worktreePath" ;;
esac
