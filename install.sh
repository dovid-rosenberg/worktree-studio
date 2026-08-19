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

# The pre-push hook that runs what CI runs. Tracked in .githooks/ rather than
# .git/hooks/ so it survives a clone; this line is what actually arms it. Without
# it the repo's own checks are unreachable locally, which is how CI came to run red
# for twelve consecutive pushes without anyone noticing.
git config core.hooksPath .githooks
echo "→ armed pre-push hook (npm run verify). Bypass once with: git push --no-verify"

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

chmod +x swiftbar/*.sh 2>/dev/null || true

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
  # Your locale, captured at install time — launchd provides none, and the fallback is
  # a US-ASCII charmap that makes every prompt glyph three characters wide.
  AGENT_LANG="${LANG:-en_US.UTF-8}"
  mkdir -p "$STATE_DIR" "$HOME/Library/LaunchAgents"
  sed -e "s|{{NODE}}|$NODE|g" \
      -e "s|{{SERVER}}|$REPO/server/server.ts|g" \
      -e "s|{{REPO}}|$REPO|g" \
      -e "s|{{PATH}}|$AGENT_PATH|g" \
      -e "s|{{LANG}}|$AGENT_LANG|g" \
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
  # `wt-studio endpoint` prints shell-evaluable assignments — one call, no parsing here.
  if eval "$(node bin/wt-studio.ts endpoint 2>/dev/null)" 2>/dev/null && [ -n "${WT_STUDIO_TOKEN:-}" ]; then
    echo "  →  $WT_STUDIO_BASE/?token=$WT_STUDIO_TOKEN"
  else
    echo "  →  run 'node bin/wt-studio.ts endpoint' for the URL to open"
  fi
else
  echo "Done. Start the app:  npm start"
  echo "Start it at login instead:  ./install.sh --autostart"
fi
# The URL has to carry the token on the first visit. The document is gated — serving the
# shell to anything that asked was how the boot token reached any local process on the
# machine — and the page swaps the token for a cookie and strips it from the address bar
# immediately, so this is a one-time hand-over and not a URL to bookmark. Printed only
# when the server is already running; before a first start there is no token to read.
echo "The menubar's \"Open cockpit\" always carries it for you."

echo "Config: ~/.config/worktree-studio/config.json"
