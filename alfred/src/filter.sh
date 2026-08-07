#!/usr/bin/env bash
# Alfred Script Filter — sessions and worktrees from Worktree Studio's API.
#
#   ⏎ open in editor   ⌘ Finder   ⌃ start servers   ⌥ stop servers   ⇧ cockpit
#   (on a session with a ticket, ⌥ opens the ticket instead — see below)
#
# Alfred runs this on every keystroke, so it does one 2-second-capped request and
# no work of its own: Alfred does the filtering (`alfredfiltersresults`), which is
# both faster and better at fuzzy matching than anything done here.
#
# This script is SELF-CONTAINED on purpose. Alfred copies a workflow into its own
# preferences folder on import, so a bundled script can never resolve a path back
# to this checkout — anything it needs, it has to carry.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

CFG="${WT_STUDIO_CONFIG:-$HOME/.config/worktree-studio/config.json}"
PORT="$(jq -r '.web.port // 7788' "$CFG" 2>/dev/null || echo 7788)"
BASE="http://127.0.0.1:$PORT"
# The API needs the boot token — mode 0600 in the state dir, readable only by us.
STATE_DIR="${WT_STUDIO_STATE:-$HOME/.local/state/worktree-studio}"
TOKEN="$(cat "$STATE_DIR/token" 2>/dev/null | tr -d '[:space:]')"
STATE="$(curl -s -m 2 -H "x-wts-token: $TOKEN" "$BASE/api/state" 2>/dev/null)"

# A refusal is a response, so "empty" no longer means "down" — say which it was.
if ! echo "$STATE" | jq -e 'has("repos")' >/dev/null 2>&1; then
  if [ -n "$STATE" ]; then
    echo "$STATE" | jq -c --arg dir "$STATE_DIR" \
      '{items:[{title:"Worktree Studio refused this request",
                subtitle:((.error // "unexpected response")+" — check the token in "+$dir),
                valid:false}]}'
  else
    echo '{"items":[{"title":"Worktree Studio is not running","subtitle":"Start it: ./install.sh --autostart, or npm start","valid":false}]}'
  fi
  exit 0
fi

# Sessions first, then worktrees. A session is a thing you are *doing*; a worktree
# is where it lives. One action script serves both — a session that has not been
# promoted yet simply has no path, and its path-shaped modifiers are marked
# invalid rather than silently doing nothing.
#
# Every item's whole payload rides in `arg`, as JSON, rather than in per-item
# `variables`. The variables did not survive the hop to the action script: an
# ⏎ on a session reached the API with an empty path and was refused ("path or
# paths is required"). `arg` is the one channel Alfred is guaranteed to deliver,
# and `mods` can override it per modifier — so one mechanism carries everything
# and there is no second one to be wrong.
echo "$STATE" | jq -c --arg base "$BASE" '
  def dot(s): if s=="working" then "⚙" elif s=="waiting" then "🟡"
              elif s=="stopped" then "⏹" else "○" end;
  def rank(s): if s=="waiting" then 0 elif s=="working" then 1
               elif s=="idle" then 2 else 3 end;

  ( [ .sessions[]? | select(.active) ]
    | sort_by(rank(.state), -(.lastEventAt // .createdAt))
    | map(
        (.worktreePath // "") as $p
      | { uid: .id,
          title: "\(dot(.state)) \(.title)",
          # `activity` is the human-readable form of `state` ("running Bash",
          # "turn done"), so printing both gives you "idle · session started".
          # Prefer activity, fall back to state.
          subtitle: ( "session · \(.activity // .state)"
            + (if .branch then " · \(.repoName) \(.branch)" else " · \(.repoName) (not promoted)" end) ),
          arg: ({ wtaction: "open", path: $p, repo: .repoName, worktreePath: $p } | tojson),
          valid: ($p != ""),
          mods: {
            cmd:   { subtitle: (if $p=="" then "no worktree yet" else "Reveal in Finder" end),
                     valid: ($p != ""), arg: ({ wtaction: "finder", path: $p } | tojson) },
            ctrl:  { subtitle: (if $p=="" then "no worktree yet" else "Start the feature stack" end),
                     valid: ($p != ""), arg: ({ wtaction: "group-start", group: .feature } | tojson) },
            alt:   ( if .sourceUrl
                     then { subtitle: "Open \(.source) \(.sourceId // "ticket") ↗",
                            valid: true, arg: ({ wtaction: "url", url: .sourceUrl } | tojson) }
                     else { subtitle: (if $p=="" then "no worktree yet" else "Stop the feature stack" end),
                            valid: ($p != ""), arg: ({ wtaction: "group-stop", group: .feature } | tojson) } end ),
            shift: { subtitle: "Open the cockpit", valid: true,
                     arg: ({ wtaction: "url", url: $base } | tojson) } },
          match: "\(.title) \(.repoName) \(.branch // "") \(.feature) \(.sourceId // "")" } ) ) as $sessions

  | ( [ .repos[]? as $r | $r.worktrees[]? | select(.isMain | not) ]
      # Running first, then alphabetical — sorted while the fields still exist,
      # rather than by pattern-matching the rendered subtitle afterwards.
      | sort_by([(.running | not), (.repo | ascii_downcase), (.wtname | ascii_downcase)])
      | map(
          { uid: .path,
            title: "\(if .running then "🟢" else "⚪" end) \(.repo) › \(.wtname)",
            subtitle: ( (.branch // "detached")
              + (if .running
                 then "  ●" + ((.ports // []) | map(":" + tostring) | join(" ") | (if .=="" then " running" else " " + . end))
                 else "  ○ stopped" end)
              + (if .session then "  · agent \(.session.state)" else "" end)
              + (if .merged then "  · merged" else "" end) ),
            arg: ({ wtaction: "open", path: .path, repo: .repo, worktreePath: .path } | tojson),
            mods: {
              cmd:   { subtitle: "Reveal in Finder",
                       arg: ({ wtaction: "finder", path: .path } | tojson) },
              ctrl:  { subtitle: (if .canStart then "Start the dev server" else "no start command configured for \(.repo)" end),
                       valid: .canStart,
                       arg: ({ wtaction: "start", repo: .repo, worktreePath: .path } | tojson) },
              alt:   { subtitle: (if .running then "Stop the dev server" else "not running" end),
                       valid: .running,
                       arg: ({ wtaction: "stop", repo: .repo, worktreePath: .path } | tojson) },
              shift: { subtitle: "Open the cockpit", valid: true,
                       arg: ({ wtaction: "url", url: $base } | tojson) } },
            match: "\(.repo) \(.wtname) \(.branch // "")" } ) ) as $worktrees

  | { items: ($sessions + $worktrees) }'
