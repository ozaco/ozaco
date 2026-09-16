#!/usr/bin/env bash
# Run the FULL db test suite, postgres e2e included. Uses DB_TEST_PG_URL when already set;
# otherwise spins a disposable postgres:16 container (random host port) and tears it down after.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${DB_TEST_PG_URL:-}" ]; then
  exec bun test "$@"
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — start it, or set DB_TEST_PG_URL to a live postgres" >&2
  exit 1
fi

NAME="ozaco-db-e2e-$$"
docker run -d --rm --name "$NAME" \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=ozaco_test \
  -p 127.0.0.1:0:5432 postgres:16-alpine >/dev/null
trap 'docker stop "$NAME" >/dev/null 2>&1 || true' EXIT

PORT="$(docker port "$NAME" 5432/tcp | head -1 | awk -F: '{print $NF}')"

# The image's entrypoint starts postgres TWICE: an init-only server on the unix socket alone
# (`listen_addresses=''`), then the real one. A socket-side `pg_isready` answers during the init
# phase, and the suite then hits ECONNREFUSED on the published port once that server restarts —
# reliably so when the other docker legs run alongside (`moon run :test-all`). Probe over TCP
# inside the container (only the real server listens there), then the published port from here.
ready=0
for _ in $(seq 1 240); do
  if docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -d ozaco_test >/dev/null 2>&1 \
    && (echo > "/dev/tcp/127.0.0.1/${PORT}") >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done

if [ "$ready" -ne 1 ]; then
  echo "postgres did not come up on 127.0.0.1:${PORT} within 60s" >&2
  docker logs "$NAME" 2>&1 | tail -20 >&2
  exit 1
fi

DB_TEST_PG_URL="postgres://postgres:test@127.0.0.1:${PORT}/ozaco_test" bun test "$@"
