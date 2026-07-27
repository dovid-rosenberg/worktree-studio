#!/usr/bin/env bash
# Alfred Script Filter — lists worktrees from Worktree Studio's API.
# Enter=open editor · ⌘=stop server · ⌃=start server · ⌥=Finder · ⇧=pop out session
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
CFG="${WT_STUDIO_CONFIG:-$HOME/.config/worktree-studio/config.json}"
PORT="$(jq -r '.web.port // 7788' "$CFG" 2>/dev/null || echo 7788)"
# The API needs the boot token — mode 0600 in the state dir, readable only by us.
STATE_DIR="${WT_STUDIO_STATE:-$HOME/.local/state/worktree-studio}"
TOKEN="$(tr -d '[:space:]' <"$STATE_DIR/token" 2>/dev/null)"
STATE="$(curl -s -m 2 -H "x-wts-token: $TOKEN" "http://127.0.0.1:$PORT/api/state" 2>/dev/null)"

# A refusal is a response, so "empty" no longer means "down" — say which it was.
if ! echo "$STATE" | jq -e 'has("repos")' >/dev/null 2>&1; then
  if [ -n "$STATE" ]; then
    echo "$STATE" | jq -c '{items:[{title:"Worktree Studio refused this request",subtitle:((.error // "unexpected response")+" — check the token in '"$STATE_DIR"'"),valid:false}]}'
  else
    echo '{"items":[{"title":"Worktree Studio not running","subtitle":"Start it with: npm start","valid":false}]}'
  fi
  exit 0
fi

echo "$STATE" | jq -c '
  [ .repos[]? as $r | $r.worktrees[]?
    | { uid: .path,
        title: "\(.repo) › \(.wtname)",
        subtitle: ( .branch
          + (if .running then "  ●" + ((.ports//[])|map(":"+(tostring))|join(" ")|(if .=="" then " running" else " "+. end)) else "  ○ stopped" end)
          + (if .session then "  · agent " + .session.state else "" end) ),
        arg: .path,
        variables: { path: .path, repo: .repo, worktreePath: .path,
                     sessionId: (.session.id // ""), running: (.running|tostring),
                     canStart: (.canStart|tostring) },
        match: "\(.repo) \(.wtname) \(.branch)" } ]
  | sort_by(.variables.running=="true"|not)
  | { items: . }'
