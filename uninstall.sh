#!/usr/bin/env bash
# Reverse install.sh: the launchd agent and the SwiftBar plugin symlink.
# Leaves your config and state (sessions, token) alone — delete those yourself
# if you want a clean slate:
#   rm -rf ~/.config/worktree-studio ~/.local/state/worktree-studio
set -uo pipefail
say() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }

PLIST="$HOME/Library/LaunchAgents/com.worktree-studio.plist"
if [ -f "$PLIST" ]; then
  launchctl bootout "gui/$UID/com.worktree-studio" 2>/dev/null ||
    launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  say "Removed launchd agent (the server stops at the next logout, or kill it now)"
fi

SB="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)"
[ -n "$SB" ] || SB="$HOME/.swiftbar/plugins"
DEST="$SB/wt-studio.10s.sh"
if [ -L "$DEST" ]; then
  rm -f "$DEST"
  say "Removed SwiftBar plugin symlink"
  open "swiftbar://refreshallplugins" 2>/dev/null || true
fi

say "Done."
