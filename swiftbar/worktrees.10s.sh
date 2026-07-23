#!/usr/bin/env bash
# <xbar.title>Worktree Studio</xbar.title>
# <xbar.desc>Features, agents, and dev servers from Worktree Studio.</xbar.desc>
# <xbar.dependencies>jq, worktree-studio</xbar.dependencies>
#
# Thin menubar reader over Worktree Studio's API (replaces worktree-dash core.sh).
# Renders features with agent status + server dots; actions POST to the studio server.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

CFG="${WT_STUDIO_CONFIG:-$HOME/.config/worktree-studio/config.json}"
PORT="$(jq -r '.web.port // 7788' "$CFG" 2>/dev/null || echo 7788)"
BASE="http://127.0.0.1:$PORT"
ACT="$HOME/worktree-studio/swiftbar/wts-action.sh"

STATE="$(curl -s -m 2 "$BASE/api/state" 2>/dev/null)"
if [ -z "$STATE" ]; then
  echo "⎇ ⚠"
  echo "---"
  echo "Worktree Studio not running | color=#d05f30"
  echo "Start it | bash=/bin/bash param1=-lc param2=cd $HOME/worktree-studio && npm start terminal=true"
  exit 0
fi

WAIT="$(echo "$STATE" | jq '[.sessions[]?|select(.state=="waiting")]|length')"
RUN="$(echo "$STATE" | jq '.runningTotal // 0')"
if [ "$WAIT" -gt 0 ]; then echo "⎇ $WAIT waiting"; elif [ "$RUN" -gt 0 ]; then echo "⎇ ▶$RUN"; else echo "⎇"; fi
echo "---"
echo "＋ New session… | href=$BASE"
echo "Open cockpit | href=$BASE"
echo "---"

echo "$STATE" | jq -r --arg act "$ACT" '
  def dot(s): if s=="working" then "⚙" elif s=="waiting" then "🟡" elif s=="done" then "✓" else "○" end;
  .features[]? as $f
  | ($f.members | map(select(.missing|not))) as $m
  | ($m | map(select(.running)) | length) as $up
  | ($m | length) as $tot
  | ( if ($m|any(.session.state=="waiting")) then "🟡"
      elif ($m|any(.session.state=="working")) then "⚙"
      elif $up>0 then "🟢" else "⚪" end ) as $sym
  | "\($sym) \($f.name)  (\($up)/\($tot))\($f.auto|if . then "" else " · manual" end)",
  ( $m[]
    | "--\(if .running then "🟢" else "⚪" end) \(.repo) \(.branch // .wtname)"
      + (if (.ports|length)>0 then "  :\(.ports|join(","))" else "" end)
      + (if .session then "  · claude \(dot(.session.state))" else "" end) ),
  ( "--Run / switch stack | bash=\($act) param1=group-start param2=\($f.name) terminal=false refresh=true" ),
  ( "--Stop stack | bash=\($act) param1=group-stop param2=\($f.name) terminal=false refresh=true" ),
  ( "--Restart stack | bash=\($act) param1=group-restart param2=\($f.name) terminal=false refresh=true" ),
  "-----"
'
echo "---"
echo "Refresh | refresh=true"
echo "Edit config… | bash=/usr/bin/open param1=$CFG terminal=false"
