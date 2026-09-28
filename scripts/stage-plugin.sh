#!/usr/bin/env bash
# Stage the plugin into the isolated XDG config used by integration tests.
# Tests must run against a real deployed copy, never the repo in-place.
set -euo pipefail
STAGE="${JAZZ_STAGE_DIR:-/tmp/opencode/jazz-it/xdg/opencode/plugins/jazz}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$STAGE"
rsync -a --delete --exclude node_modules --exclude .git --exclude test "$REPO/" "$STAGE/"
if [ ! -d "$STAGE/node_modules/@opencode/plugin" ]; then
  (cd "$STAGE" && npm install --omit=dev --silent)
fi
echo "staged: $STAGE"
