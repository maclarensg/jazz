#!/usr/bin/env bash
# Deploy opencode-jazz into the user's global OpenCode plugins dir as a
# symlink (live-edits apply at next server restart — no copy step).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${HOME}/.config/opencode/plugins/jazz"
ln -sfn "$REPO" "$TARGET"
echo "deployed: $TARGET -> $REPO"
echo "note: the plugin activates when the OpenCode server (re)starts."
echo "      from inside an OpenCode session, restart it EXTERNALLY:"
echo "        opencode service restart   # run outside any session"
