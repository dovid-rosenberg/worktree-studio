#!/usr/bin/env bash
# <xbar.title>Worktree Studio</xbar.title>
# <xbar.desc>Sessions, features and dev servers from Worktree Studio.</xbar.desc>
# <xbar.dependencies>jq, worktree-studio</xbar.dependencies>
#
# A menubar reader over Worktree Studio's API. The menubar's job is *attention*:
# the title says whether an agent is blocked on you, and the first section is the
# sessions themselves — not the worktrees they happen to live in. Features and
# their dev servers come second, because a stack you can start is less urgent
# than an agent standing still waiting for an answer.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

CFG="${WT_STUDIO_CONFIG:-$HOME/.config/worktree-studio/config.json}"
PORT="$(jq -r '.web.port // 7788' "$CFG" 2>/dev/null || echo 7788)"
BASE="http://127.0.0.1:$PORT"
# Where this checkout lives. Derived from the script's own path rather than
# hardcoded: SwiftBar SYMLINKS plugins into its own folder, hence the resolve
# loop. WT_STUDIO_HOME overrides it.
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  LINK_DIR="$(cd -P "$(dirname "$SELF")" && pwd)"
  SELF="$(readlink "$SELF")"
  case "$SELF" in /*) ;; *) SELF="$LINK_DIR/$SELF" ;; esac
done
REPO="${WT_STUDIO_HOME:-$(cd -P "$(dirname "$SELF")/.." && pwd)}"
ACT="$REPO/swiftbar/wts-action.sh"
# The API needs the boot token; it lives in the state dir at mode 0600, so only
# processes running as this user can read it.
STATE_DIR="${WT_STUDIO_STATE:-$HOME/.local/state/worktree-studio}"
TOKEN="$(cat "$STATE_DIR/token" 2>/dev/null | tr -d '[:space:]')"
LOG="$STATE_DIR/studio.log"
AGENT="com.worktree-studio"

# ── The daemon itself ──────────────────────────────────────────────────────
# Asked once, and only of launchd, because "is the API answering" and "is the
# daemon healthy" are different questions. With KeepAlive set, a crashing daemon
# is *restarted within seconds*, so "not running" would flicker past and the
# obvious fix — a Start button — would be pressing a button launchd is already
# pressing. What you need to see instead is WHY it isn't answering: never
# installed, crash-looping (a nonzero last exit and a climbing run count), or up
# but still booting.
AGENT_STATE=""; AGENT_PID=""; AGENT_RUNS=""; AGENT_EXIT=""
if PRINT="$(launchctl print "gui/$UID/$AGENT" 2>/dev/null)"; then
  AGENT_STATE="$(printf '%s' "$PRINT" | awk -F' = ' '/^\tstate = /{print $2; exit}')"
  AGENT_PID="$(printf '%s' "$PRINT" | awk -F' = ' '/^\tpid = /{print $2; exit}')"
  AGENT_RUNS="$(printf '%s' "$PRINT" | awk -F' = ' '/^\truns = /{print $2; exit}')"
  AGENT_EXIT="$(printf '%s' "$PRINT" | awk -F' = ' '/^\tlast exit code = /{print $2; exit}')"
fi

restart_item() {
  echo "Restart the daemon | bash=/bin/launchctl param1=kickstart param2=-k param3=gui/$UID/$AGENT terminal=false refresh=true"
}
log_item() { [ -f "$LOG" ] && echo "Open the log | bash=/usr/bin/open param1=$LOG terminal=false"; }

STATE="$(curl -s -m 2 -H "x-wts-token: $TOKEN" "$BASE/api/state" 2>/dev/null)"
# A refusal is a *response*, so "empty" no longer means "down" — tell the two
# apart rather than reporting a rejected token as a stopped server.
if ! echo "$STATE" | jq -e 'has("sessions")' >/dev/null 2>&1; then
  echo "⎇ ⚠"
  echo "---"
  if [ -n "$STATE" ]; then
    echo "Worktree Studio refused this request | color=#d05f30"
    echo "$(echo "$STATE" | jq -r '.error // "unexpected response"') — check $STATE_DIR/token"
    log_item
  elif [ -z "$AGENT_STATE" ]; then
    echo "Worktree Studio is not running | color=#d05f30"
    echo "No login agent installed — nothing will restart it"
    echo "---"
    echo "Start it now | bash=/bin/bash param1=-lc param2=cd $REPO && npm start terminal=true"
    echo "Start it at every login… | bash=/bin/bash param1=-lc param2=cd $REPO && ./install.sh --autostart terminal=true"
    log_item
  elif [ "$AGENT_STATE" = running ]; then
    # launchd has a live process that is not answering: either mid-boot (the
    # client build and the repo scan take a moment) or wedged. Never a Start.
    echo "Worktree Studio is starting, or wedged | color=#d0a030"
    echo "launchd has pid $AGENT_PID, but the API is not answering yet"
    echo "---"
    restart_item
    log_item
  else
    echo "Worktree Studio keeps crashing | color=#d05f30"
    [ -n "$AGENT_EXIT" ] && [ "$AGENT_EXIT" != 0 ] &&
      echo "Last exit code $AGENT_EXIT after $AGENT_RUNS launch(es) — launchd is retrying"
    echo "---"
    echo "Read the log first — a restart will do the same thing | color=#888888"
    log_item
    restart_item
  fi
  exit 0
fi

# ── Title ──────────────────────────────────────────────────────────────────
# One number, chosen by urgency: agents waiting on you, else agents working,
# else dev servers up. Anything else is noise in a menubar.
WAIT="$(echo "$STATE" | jq '[.sessions[]?|select(.active and .state=="waiting")]|length')"
WORK="$(echo "$STATE" | jq '[.sessions[]?|select(.active and .state=="working")]|length')"
RUN="$(echo "$STATE" | jq '.runningTotal // 0')"
if   [ "$WAIT" -gt 0 ]; then echo "⎇ 🟡$WAIT"
elif [ "$WORK" -gt 0 ]; then echo "⎇ ⚙$WORK"
elif [ "$RUN"  -gt 0 ]; then echo "⎇ ▶$RUN"
else                         echo "⎇"
fi
echo "---"
echo "Open cockpit | href=$BASE"
echo "New session… | href=$BASE"
echo "---"

# ── Sessions ───────────────────────────────────────────────────────────────
# Waiting first: the whole point of the section is "who needs you". Each line
# deep-links to that session in the cockpit (`#s:<id>`), so clicking the agent
# that wants you lands on the agent that wants you.
echo "$STATE" | jq -r --arg base "$BASE" '
  def dot(s): if s=="working" then "⚙" elif s=="waiting" then "🟡"
              elif s=="stopped" then "⏹" else "○" end;
  def rank(s): if s=="waiting" then 0 elif s=="working" then 1
               elif s=="idle" then 2 else 3 end;
  ([.sessions[]? | select(.active)] | sort_by(rank(.state), -(.lastEventAt // .createdAt))) as $s
  | if ($s|length) == 0 then "No active sessions | color=#888888"
    else
      "Sessions | color=#888888",
      ( $s[]
        | "\(dot(.state)) \(.title) | href=\($base)/#s:\(.id|@uri)",
          "--\(.activity // .state)",
          ( if .sourceUrl then "--\(.source): \(.sourceId // "link") ↗ | href=\(.sourceUrl)" else empty end ),
          ( .repos[]?
            | "--\(.repo) \(.branch // "· not promoted yet")" ),
          ( if .feature then "--Feature: \(.feature)" else empty end ) )
    end'
echo "---"

# ── Features and their dev servers ─────────────────────────────────────────
# `slot` is present only while one is allocated, and absent is not slot 0 —
# hence `has("slot")` rather than a truthiness test that would hide slot 0.
echo "$STATE" | jq -r --arg act "$ACT" --arg base "$BASE" '
  def dot(s): if s=="working" then "⚙" elif s=="waiting" then "🟡" else "○" end;
  if (.features|length) == 0 then "No features | color=#888888"
  else
    "Features | color=#888888",
    ( .features[] as $f
      | ($f.members | map(select(.missing|not))) as $m
      | ($m | map(select(.running)) | length) as $up
      | ($m | length) as $tot
      | ( if ($m|any(.session.state=="waiting")) then "🟡"
          elif ($m|any(.session.state=="working")) then "⚙"
          elif $up>0 then "🟢" else "⚪" end ) as $sym
      # The feature line deep-links the same way the session lines do: to its
      # agent when it has one, since that is what the cockpit would show anyway,
      # and to the feature itself when it does not.
      | "\($sym) \($f.name)  (\($up)/\($tot))"
          + ($f.auto|if . then "" else " · manual" end)
          + (if ($f|has("slot")) then "  · slot \($f.slot)" else "" end)
          + ( if $f.session then " | href=\($base)/#s:\($f.session.id|@uri)"
              else " | href=\($base)/#f:\($f.name|@uri)" end ),
        ( $m[]
          | "--\(if .running then "🟢" else "⚪" end) \(.repo) \(.branch // .wtname)"
            + (if (.ports|length)>0 then "  :\(.ports|join(","))" else "" end)
            + (if .merged then "  · merged" else "" end)
            + (if .session then "  · agent \(dot(.session.state))" else "" end) ),
        ( $f.members | map(select(.missing)) | .[]? | "--⚠ missing: \(.ref) | color=#d05f30" ),
        "-----",
        "--Run / switch stack | bash=\($act) param1=group-start param2=\($f.name) terminal=false refresh=true",
        "--Stop stack | bash=\($act) param1=group-stop param2=\($f.name) terminal=false refresh=true",
        "--Restart stack | bash=\($act) param1=group-restart param2=\($f.name) terminal=false refresh=true",
        "--Open in editor | bash=\($act) param1=group-open param2=\($f.name) terminal=false refresh=true" )
  end'

echo "---"
# The daemon, when it is fine. A green line most days is the point: it is how you
# learn what healthy looks like, so the amber and red ones above mean something.
if [ "$AGENT_STATE" = running ]; then
  echo "🟢 Daemon: running at login · pid $AGENT_PID"
  echo "--launchd agent com.worktree-studio, $AGENT_RUNS launch(es) since login"
  echo "--Restart it | bash=/bin/launchctl param1=kickstart param2=-k param3=gui/$UID/$AGENT terminal=false refresh=true"
  echo "--Stop it until next login | bash=/bin/launchctl param1=bootout param2=gui/$UID/$AGENT terminal=false refresh=true"
elif [ -n "$AGENT_STATE" ]; then
  # An agent that exists but is not the process answering us: someone is running
  # a second copy by hand. Worth saying, because kickstart would fight it.
  echo "🟡 Daemon: answering, but the login agent is $AGENT_STATE"
  echo "--Something else is serving port $PORT — a hand-started 'npm start', probably"
else
  echo "🟡 Daemon: started by hand — it dies when you close its terminal"
  echo "--Start it at every login… | bash=/bin/bash param1=-lc param2=cd $REPO && ./install.sh --autostart terminal=true"
fi
[ -f "$LOG" ] && echo "--Open the log | bash=/usr/bin/open param1=$LOG terminal=false"
echo "---"
echo "Refresh | refresh=true"
echo "Edit config… | bash=/usr/bin/open param1=$CFG terminal=false"
