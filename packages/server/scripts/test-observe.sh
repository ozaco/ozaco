#!/usr/bin/env bash
# Run the observe leg (tests/observe) against REAL backends: grafana/otel-lgtm (the OTLP collector,
# Tempo, Loki, Prometheus, Grafana) and OpenObserve. Uses SERVER_TEST_OTLP_URL, _TEMPO_URL,
# _LOKI_URL, _GRAFANA_URL, _PROM_URL and _OPENOBSERVE_URL (+ _OPENOBSERVE_USER / _PASS, _GRAFANA_USER
# / _PASS) when they are all set already; otherwise spins disposable containers on random host
# ports. Images are pinned (override with SERVER_TEST_LGTM_IMAGE / SERVER_TEST_OPENOBSERVE_IMAGE):
# otel-lgtm 0.34.0 = Grafana 13.2.2, Tempo 3.0.3, Loki 3.7.8, collector 0.161; OpenObserve v1.0.4.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${SERVER_TEST_OTLP_URL:-}" ] && [ -n "${SERVER_TEST_TEMPO_URL:-}" ] &&
  [ -n "${SERVER_TEST_LOKI_URL:-}" ] && [ -n "${SERVER_TEST_GRAFANA_URL:-}" ] &&
  [ -n "${SERVER_TEST_PROM_URL:-}" ] && [ -n "${SERVER_TEST_OPENOBSERVE_URL:-}" ]; then
  exec bun test tests/observe "$@"
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — start it, or set the SERVER_TEST_*_URL backends (see this script)" >&2
  exit 1
fi

LGTM_IMAGE="${SERVER_TEST_LGTM_IMAGE:-grafana/otel-lgtm:0.34.0}"
OO_IMAGE="${SERVER_TEST_OPENOBSERVE_IMAGE:-public.ecr.aws/zinclabs/openobserve:v1.0.4}"
OO_USER="root@ozaco.dev"
# OpenObserve panics at boot on a weak root password (8-128 chars, upper + lower + digit + special)
OO_PASS='Ozaco-pass1!'

LGTM="ozaco-server-lgtm-$$"
OO="ozaco-server-oo-$$"
# no --rm: a container that dies during boot keeps its log for the readiness report below;
# `rm -f` stops AND removes both on every exit
trap 'docker rm -f "$LGTM" "$OO" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$LGTM" \
  -p 127.0.0.1:0:3000 -p 127.0.0.1:0:3100 -p 127.0.0.1:0:3200 -p 127.0.0.1:0:4318 \
  -p 127.0.0.1:0:9090 "$LGTM_IMAGE" >/dev/null
docker run -d --name "$OO" \
  -e ZO_ROOT_USER_EMAIL="$OO_USER" -e ZO_ROOT_USER_PASSWORD="$OO_PASS" -e ZO_DATA_DIR=/data \
  -p 127.0.0.1:0:5080 "$OO_IMAGE" >/dev/null

port() { # container, container port
  docker port "$1" "$2/tcp" | head -1 | awk -F: '{print $NF}'
}

# Wait until a probe succeeds; fail fast when the container died, loudly (its log tail) on timeout.
wait_for() { # container, what, seconds, probe...
  local name="$1" what="$2" seconds="$3"
  shift 3
  for _ in $(seq 1 $((seconds * 4))); do
    "$@" >/dev/null 2>&1 && return 0
    if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != "true" ]; then
      echo "$what: container $name exited" >&2
      docker logs "$name" 2>&1 | tail -20 >&2
      return 1
    fi
    sleep 0.25
  done
  echo "$what did not become ready within ${seconds}s" >&2
  docker logs "$name" 2>&1 | tail -20 >&2
  return 1
}

GRAFANA_PORT="$(port "$LGTM" 3000)"
LOKI_PORT="$(port "$LGTM" 3100)"
TEMPO_PORT="$(port "$LGTM" 3200)"
OTLP_PORT="$(port "$LGTM" 4318)"
PROM_PORT="$(port "$LGTM" 9090)"
OO_PORT="$(port "$OO" 5080)"

# otel-lgtm writes /tmp/ready once every component started; then ask each one itself
wait_for "$LGTM" "otel-lgtm" 120 docker exec "$LGTM" test -f /tmp/ready
wait_for "$LGTM" "tempo" 60 curl -fsS "http://127.0.0.1:${TEMPO_PORT}/ready"
wait_for "$LGTM" "loki" 60 curl -fsS "http://127.0.0.1:${LOKI_PORT}/ready"
wait_for "$LGTM" "grafana" 60 curl -fsS "http://127.0.0.1:${GRAFANA_PORT}/api/health"
wait_for "$LGTM" "prometheus" 60 curl -fsS "http://127.0.0.1:${PROM_PORT}/-/ready"
wait_for "$OO" "openobserve" 60 curl -fsS "http://127.0.0.1:${OO_PORT}/healthz"

export SERVER_TEST_OTLP_URL="http://127.0.0.1:${OTLP_PORT}"
export SERVER_TEST_TEMPO_URL="http://127.0.0.1:${TEMPO_PORT}"
export SERVER_TEST_LOKI_URL="http://127.0.0.1:${LOKI_PORT}"
export SERVER_TEST_GRAFANA_URL="http://127.0.0.1:${GRAFANA_PORT}"
export SERVER_TEST_GRAFANA_USER="admin" SERVER_TEST_GRAFANA_PASS="admin"
export SERVER_TEST_PROM_URL="http://127.0.0.1:${PROM_PORT}"
export SERVER_TEST_OPENOBSERVE_URL="http://127.0.0.1:${OO_PORT}"
export SERVER_TEST_OPENOBSERVE_USER="$OO_USER" SERVER_TEST_OPENOBSERVE_PASS="$OO_PASS"

bun test tests/observe "$@"
