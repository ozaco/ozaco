#!/usr/bin/env bash
# Run the transport suite against NATS. Uses TRANSPORT_TEST_NATS_URL when already set; otherwise
# spins a disposable nats:2-alpine container (random host port) and tears it down after.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${TRANSPORT_TEST_NATS_URL:-}" ]; then
  exec bun test tests/nats.test.ts "$@"
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — start it, or set TRANSPORT_TEST_NATS_URL to a live nats server" >&2
  exit 1
fi

NAME="ozaco-transport-nats-$$"
# a fixed host port: the interruption tests restart the container and must find it again
PORT="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
docker run -d --rm --name "$NAME" -p "127.0.0.1:${PORT}:4222" nats:2-alpine -js -sd /data >/dev/null
trap 'docker stop "$NAME" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 60); do
  (echo > "/dev/tcp/127.0.0.1/${PORT}") >/dev/null 2>&1 && break
  sleep 0.25
done

TRANSPORT_TEST_NATS_URL="nats://127.0.0.1:${PORT}" TRANSPORT_TEST_NATS_CONTAINER="$NAME" \
  bun test tests/nats.test.ts "$@"
