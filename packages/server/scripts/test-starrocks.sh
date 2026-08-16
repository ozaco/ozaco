#!/usr/bin/env bash
# Run the metrics test suite, StarRocks e2e included. Uses SERVER_TEST_STARROCKS_FE when already
# set; otherwise spins a disposable starrocks/allin1-ubuntu container (random localhost ports) and
# tears it down after. Exports:
#   SERVER_TEST_STARROCKS_FE    — FE HTTP url (stream load ingest)
#   SERVER_TEST_STARROCKS_QUERY — FE MySQL host:port (queries/DDL)
#   SERVER_TEST_STARROCKS_BE    — BE HTTP url override (stream load redirects are NATed by docker)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${SERVER_TEST_STARROCKS_FE:-}" ]; then
  exec bun test tests/metrics/ "$@"
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — start it, or set SERVER_TEST_STARROCKS_FE to a live StarRocks FE" >&2
  exit 1
fi

IMAGE="starrocks/allin1-ubuntu:3.5.20"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "WARNING: pulling ${IMAGE} — this image is multi-GB, the first run can take a long while" >&2
fi

NAME="ozaco-sr-e2e-$$"
docker run -d --rm --name "$NAME" \
  -p 127.0.0.1:0:8030 -p 127.0.0.1:0:9030 -p 127.0.0.1:0:8040 \
  "$IMAGE" >/dev/null
trap 'docker stop "$NAME" >/dev/null 2>&1 || true' EXIT

port_of() {
  docker port "$NAME" "$1/tcp" | head -1 | awk -F: '{print $NF}'
}

FE_PORT="$(port_of 8030)"
MYSQL_PORT="$(port_of 9030)"
BE_PORT="$(port_of 8040)"

echo "waiting for StarRocks (FE http :${FE_PORT}, mysql :${MYSQL_PORT}, BE http :${BE_PORT})..."
# `show backends` flips to `Alive: true` BEFORE the BE has reported its disks — DDL still fails
# with "no available capacity" for a moment — so readiness is a real replication-1 CREATE TABLE.
PROBE='create database if not exists ozaco_readiness;
create table if not exists ozaco_readiness.probe (ts bigint not null)
engine=olap duplicate key(ts) distributed by hash(ts) buckets 1
properties("replication_num"="1");
drop database ozaco_readiness'
ready=""
for _ in $(seq 1 240); do
  if docker exec "$NAME" mysql -h127.0.0.1 -P9030 -uroot -e "$PROBE" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [ -z "$ready" ]; then
  echo "StarRocks did not become ready in time" >&2
  exit 1
fi

SERVER_TEST_STARROCKS_FE="http://127.0.0.1:${FE_PORT}" \
  SERVER_TEST_STARROCKS_QUERY="127.0.0.1:${MYSQL_PORT}" \
  SERVER_TEST_STARROCKS_BE="http://127.0.0.1:${BE_PORT}" \
  bun test tests/metrics/ "$@"
