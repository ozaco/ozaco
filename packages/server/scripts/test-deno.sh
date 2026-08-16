#!/usr/bin/env bash
# Real-deno e2e smoke: the deno gateway adapter with the REAL Deno.serve + Deno.upgradeWebSocket,
# driven from the BUILT dist by scripts/smoke-deno.mjs (deno resolves the workspace node_modules).
# Needs a system `deno` >= 2. Build first — moon task server:test-deno depends on server:build.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v deno >/dev/null 2>&1; then
  echo "deno is not installed — install deno >= 2, or skip this suite" >&2
  exit 1
fi

exec deno run --allow-net --allow-read scripts/smoke-deno.mjs "$@"
