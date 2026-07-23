#!/usr/bin/env bash
# Worktree Studio installer — deps, vendored assets, and (optionally) the
# SwiftBar plugin symlink. Idempotent.
set -euo pipefail
cd "$(dirname "$0")"

echo "→ npm install (builds node-pty, fixes spawn-helper, vendors xterm)"
npm install

# SwiftBar plugin symlink (if SwiftBar's plugin dir exists)
SB="$HOME/.swiftbar/plugins"
if [ -d "$SB" ]; then
  ln -sf "$PWD/swiftbar/worktrees.10s.sh" "$SB/wt-studio.10s.sh"
  echo "→ linked SwiftBar plugin → $SB/wt-studio.10s.sh"
else
  echo "· SwiftBar not detected (~/.swiftbar/plugins missing) — skipping menubar"
fi

chmod +x swiftbar/*.sh alfred/src/*.sh 2>/dev/null || true

echo
echo "Done. Start the app:  npm start   →  http://127.0.0.1:7788"
echo "Config: ~/.config/worktree-studio/config.json"
echo "Alfred: import alfred/ workflow and point its Script Filter/action at alfred/src/{filter,action}.sh"
