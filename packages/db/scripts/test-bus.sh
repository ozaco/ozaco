#!/usr/bin/env bash
# Run the bus-over-network tests against NATS (JetStream) and Redis. Uses
# TRANSPORT_TEST_NATS_URL / TRANSPORT_TEST_REDIS_URL when already set; otherwise spins disposable
# containers (random host ports) and tears them down after.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${TRANSPORT_TEST_NATS_URL:-}" ] && [ -n "${TRANSPORT_TEST_REDIS_URL:-}" ]; then
  exec bun test tests/bus-network.test.ts "$@"
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — start it, or set TRANSPORT_TEST_NATS_URL and TRANSPORT_TEST_REDIS_URL" >&2
  exit 1
fi

NATS="ozaco-db-bus-nats-$$"
REDIS="ozaco-db-bus-redis-$$"
docker run -d --rm --name "$NATS" -p 127.0.0.1:0:4222 -p 127.0.0.1:0:8222 \
  nats:2-alpine -js -m 8222 >/dev/null
docker run -d --rm --name "$REDIS" -p 127.0.0.1:0:6379 redis:7-alpine >/dev/null
trap 'docker stop "$NATS" "$REDIS" >/dev/null 2>&1 || true' EXIT

NATS_PORT="$(docker port "$NATS" 4222/tcp | head -1 | awk -F: '{print $NF}')"
REDIS_PORT="$(docker port "$REDIS" 6379/tcp | head -1 | awk -F: '{print $NF}')"

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

wait_nats "$NATS" "$(docker port "$NATS" 8222/tcp | head -1 | awk -F: '{print $NF}')"
wait_redis "$REDIS"

TRANSPORT_TEST_NATS_URL="nats://127.0.0.1:${NATS_PORT}" \
TRANSPORT_TEST_REDIS_URL="redis://127.0.0.1:${REDIS_PORT}" \
  bun test tests/bus-network.test.ts "$@"
