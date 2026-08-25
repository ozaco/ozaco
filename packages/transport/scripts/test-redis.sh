#!/usr/bin/env bash
# Run the transport suite against REDIS. Uses TRANSPORT_TEST_REDIS_URL when already set; otherwise
# spins a disposable nats:2-alpine container (random host port) and tears it down after.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${TRANSPORT_TEST_REDIS_URL:-}" ]; then
  exec bun test tests/redis.test.ts "$@"
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — start it, or set TRANSPORT_TEST_REDIS_URL to a live redis server" >&2
  exit 1
fi

NAME="ozaco-transport-redis-$$"
docker run -d --rm --name "$NAME" -p 127.0.0.1:0:6379 redis:7-alpine >/dev/null
trap 'docker stop "$NAME" >/dev/null 2>&1 || true' EXIT

PORT="$(docker port "$NAME" 6379/tcp | head -1 | awk -F: '{print $NF}')"
for _ in $(seq 1 60); do
  (echo > "/dev/tcp/127.0.0.1/${PORT}") >/dev/null 2>&1 && break
  sleep 0.25
done

TRANSPORT_TEST_REDIS_URL="redis://127.0.0.1:${PORT}" bun test tests/redis.test.ts "$@"
