#!/usr/bin/env bash
# Import the curated 200-250 profile corpus into jazz.
#   scripts/import-profiles.sh [--all]   (--all raises the cap to 1000+)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${JAZZ_PROFILE_SOURCES:-/tmp/opencode/jazz-profiles}"
MAX=240
if [[ "${1:-}" == "--all" ]]; then MAX=1000; fi

mkdir -p "$ROOT"
if [ ! -d "$ROOT/massive-agent-repo-1003/.git" ]; then
  git clone --depth 1 https://github.com/nedzreclassified/massive-agent-repo-1003.git "$ROOT/massive-agent-repo-1003"
fi

cd "$REPO"
node scripts/normalize.mjs --root "$ROOT" --out . --max "$MAX"
node scripts/sync-soul-roles.mjs --out .
echo "import complete: registry.json + profiles/ written in $REPO"
