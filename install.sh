#!/usr/bin/env bash
# Worktree Studio installer — deps, the client build, the SwiftBar plugin symlink
# and (with --autostart) a launchd agent that starts the server at login.
# Idempotent. `./uninstall.sh` reverses everything here.
set -euo pipefail
cd "$(dirname "$0")"
REPO="$PWD"

AUTOSTART=0
for arg in "$@"; do
  case "$arg" in
    --autostart) AUTOSTART=1 ;;
    -h|--help)
      echo "usage: ./install.sh [--autostart]"
      echo "  --autostart   also install a launchd agent that runs the server at login"
      exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

echo "→ npm install (builds node-pty, fixes spawn-helper, builds the client)"
npm install

# SwiftBar plugin symlink (if SwiftBar's plugin dir exists)
SB="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)"
[ -n "$SB" ] || SB="$HOME/.swiftbar/plugins"
if [ -d "$SB" ]; then
  ln -sf "$REPO/swiftbar/worktrees.10s.sh" "$SB/wt-studio.10s.sh"
  echo "→ linked SwiftBar plugin → $SB/wt-studio.10s.sh"
  open "swiftbar://refreshallplugins" 2>/dev/null || true
else
  echo "· SwiftBar not detected ($SB missing) — skipping menubar"
fi

chmod +x swiftbar/*.sh alfred/src/*.sh 2>/dev/null || true

if [ "$AUTOSTART" = 1 ]; then
  # A login agent, not a daemon: it runs as you, in your GUI session, which is what
  # tmux, your git credentials and your editor all assume.
  PLIST="$HOME/Library/LaunchAgents/com.worktree-studio.plist"
  STATE_DIR="${WT_STUDIO_STATE:-$HOME/.local/state/worktree-studio}"
  LOG="$STATE_DIR/studio.log"
  NODE="$(command -v node)"
  [ -n "$NODE" ] || { echo "node not found on PATH — install node ≥22 first" >&2; exit 1; }
  # launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin. Carry the directories the
  # server actually needs: node's own (nvm), then Homebrew for tmux/git/gh/glab.
  AGENT_PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  mkdir -p "$STATE_DIR" "$HOME/Library/LaunchAgents"
  sed -e "s|{{NODE}}|$NODE|g" \
      -e "s|{{SERVER}}|$REPO/server/server.ts|g" \
      -e "s|{{REPO}}|$REPO|g" \
      -e "s|{{PATH}}|$AGENT_PATH|g" \
      -e "s|{{LOG}}|$LOG|g" \
      launchd/com.worktree-studio.plist.template > "$PLIST"

  # bootout+bootstrap is the modern pair; load/unload is the fallback for older
  # macOS. A first-ever install has nothing to boot out, hence the `|| true`.
  launchctl bootout "gui/$UID/com.worktree-studio" 2>/dev/null || true
  if ! launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null; then
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
  fi
  echo "→ launchd agent installed → $PLIST"
  echo "  log: $LOG"
  echo "  restart: launchctl kickstart -k gui/$UID/com.worktree-studio"
fi

echo
if [ "$AUTOSTART" = 1 ]; then
  echo "Done. The server is running now and will start again at every login."
  echo "  →  http://127.0.0.1:7788"
else
  echo "Done. Start the app:  npm start   →  http://127.0.0.1:7788"
  echo "Start it at login instead:  ./install.sh --autostart"
fi
echo "Config: ~/.config/worktree-studio/config.json"
echo "Alfred: double-click alfred/Worktree Studio.alfredworkflow to import it"
