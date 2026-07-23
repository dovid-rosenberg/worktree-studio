#!/usr/bin/env bash
# Alfred Script Filter — lists worktrees from Worktree Studio's API.
# Enter=open editor · ⌘=stop server · ⌃=start server · ⌥=Finder · ⇧=pop out session
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
CFG="${WT_STUDIO_CONFIG:-$HOME/.config/worktree-studio/config.json}"
PORT="$(jq -r '.web.port // 7788' "$CFG" 2>/dev/null || echo 7788)"
STATE="$(curl -s -m 2 "http://127.0.0.1:$PORT/api/state" 2>/dev/null)"

if [ -z "$STATE" ]; then
  echo '{"items":[{"title":"Worktree Studio not running","subtitle":"Start it with: npm start","valid":false}]}'
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
