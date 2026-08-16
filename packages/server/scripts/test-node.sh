#!/usr/bin/env bash
# Real-node e2e smoke: the node gateway adapter (node:http + ws) and the worker carrier over
# worker_threads, driven from the BUILT dist by scripts/smoke-node.mjs. Needs a system `node`
# >= 22 (global fetch + WebSocket). Build first — moon task server:test-node depends on
# server:build.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed — the real-node smoke needs node >= 22" >&2
  exit 1
fi

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 22 ]; then
  echo "node >= 22 required (global fetch + WebSocket) — found $(node --version)" >&2
  exit 1
fi

exec node scripts/smoke-node.mjs "$@"
