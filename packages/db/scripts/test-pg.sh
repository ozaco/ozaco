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
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 0.5
done

DB_TEST_PG_URL="postgres://postgres:test@127.0.0.1:${PORT}/ozaco_test" bun test "$@"
