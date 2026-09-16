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

# NATS answers TCP before JetStream is up (and Redis before it loads) — a connect right after
# the port opens fails under load (`moon run :test-all`). Ask the server itself: the NATS
# monitor endpoint reports JetStream readiness, Redis answers PING. Give up loudly after 60s.
wait_nats() { # name, monitor host port
  for _ in $(seq 1 240); do
    curl -fsS "http://127.0.0.1:${2}/healthz?js-enabled-only=true" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  echo "nats ($1) did not become ready within 60s" >&2
  docker logs "$1" 2>&1 | tail -20 >&2
  return 1
}
wait_redis() { # name
  for _ in $(seq 1 240); do
    [ "$(docker exec "$1" redis-cli ping 2>/dev/null)" = "PONG" ] && return 0
    sleep 0.25
  done
  echo "redis ($1) did not become ready within 60s" >&2
  docker logs "$1" 2>&1 | tail -20 >&2
  return 1
}

wait_redis "$NAME"

TRANSPORT_TEST_REDIS_URL="redis://127.0.0.1:${PORT}" bun test tests/redis.test.ts "$@"
