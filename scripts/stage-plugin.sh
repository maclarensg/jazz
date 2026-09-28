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

# Minimal model config for the isolated serve: default model + provider block
# lifted from the user's global config (jq so no unrelated settings leak).
# Tests fire real sessions; without this the isolated server has no provider.
XDG_ROOT="${JAZZ_XDG_DIR:-$(dirname "$(dirname "$(dirname "$STAGE")")")}"
GLOBAL_CFG="${HOME}/.config/opencode/opencode.json"
if [ -f "$GLOBAL_CFG" ]; then
  mkdir -p "$XDG_ROOT/opencode/config"
  jq '{model, provider}' "$GLOBAL_CFG" > "$XDG_ROOT/opencode/config/opencode.json"
  chmod 600 "$XDG_ROOT/opencode/config/opencode.json"
fi
echo "staged: $STAGE"
