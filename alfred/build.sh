#!/usr/bin/env bash
# Build the importable Alfred workflow: alfred/Worktree Studio.alfredworkflow
#
# An .alfredworkflow is a zip of a workflow folder, so the scripts have to be at
# the bundle's root (that is the working directory Alfred runs them from). They
# live in src/ here and are COPIED in — Alfred imports by copying into its own
# preferences folder, so the bundle is a snapshot either way. Re-run this after
# editing src/, then re-import.
set -euo pipefail
cd "$(dirname "$0")"

OUT="Worktree Studio.alfredworkflow"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp info.plist "$STAGE/"
cp src/filter.sh src/action.sh "$STAGE/"
[ -f icon.png ] && cp icon.png "$STAGE/"
chmod +x "$STAGE"/*.sh
plutil -lint "$STAGE/info.plist" >/dev/null

rm -f "$OUT"
(cd "$STAGE" && zip -q -r -X "$OLDPWD/$OUT" .)
echo "→ built $PWD/$OUT"
