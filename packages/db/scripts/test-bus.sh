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
docker run -d --rm --name "$NATS" -p 127.0.0.1:0:4222 nats:2-alpine -js >/dev/null
docker run -d --rm --name "$REDIS" -p 127.0.0.1:0:6379 redis:7-alpine >/dev/null
trap 'docker stop "$NATS" "$REDIS" >/dev/null 2>&1 || true' EXIT

NATS_PORT="$(docker port "$NATS" 4222/tcp | head -1 | awk -F: '{print $NF}')"
REDIS_PORT="$(docker port "$REDIS" 6379/tcp | head -1 | awk -F: '{print $NF}')"
for port in "$NATS_PORT" "$REDIS_PORT"; do
  for _ in $(seq 1 60); do
    (echo > "/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1 && break
    sleep 0.25
  done
done

TRANSPORT_TEST_NATS_URL="nats://127.0.0.1:${NATS_PORT}" \
TRANSPORT_TEST_REDIS_URL="redis://127.0.0.1:${REDIS_PORT}" \
  bun test tests/bus-network.test.ts "$@"
