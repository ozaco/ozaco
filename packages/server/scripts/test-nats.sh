#!/usr/bin/env bash
# Run the NATS transport suite, docker e2e included. Uses SERVER_TEST_NATS_URL when already set;
# otherwise spins THREE disposable nats:2-alpine containers WITH JetStream (random host ports,
# unique names — concurrent runs never clash) and tears them down after:
#   - plain      → SERVER_TEST_NATS_URL
#   - real TLS   → SERVER_TEST_NATS_TLS_URL + SERVER_TEST_NATS_TLS_CA (throwaway CA, regenerated
#                  each run into a mktemp dir — no key material ever lands in the repo tree)
#   - nkey auth  → SERVER_TEST_NATS_NKEY_URL + SERVER_TEST_NATS_NKEY_SEED (fresh user pair per run)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${SERVER_TEST_NATS_URL:-}" ]; then
  exec bun test tests/transport/nats.test.ts "$@"
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — start it, or set SERVER_TEST_NATS_URL to a live nats server (-js)" >&2
  exit 1
fi

IMAGE="nats:2-alpine"
NAME="ozaco-nats-e2e-$$"
TLS_NAME="ozaco-nats-e2e-tls-$$"
NKEY_NAME="ozaco-nats-e2e-nkey-$$"
SCRATCH="$(mktemp -d /tmp/ozaco-nats-e2e.XXXXXX)"

cleanup() {
  docker stop "$NAME" "$TLS_NAME" "$NKEY_NAME" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

# --- throwaway TLS material: a self-signed CA + a localhost/127.0.0.1 server cert ---
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout "$SCRATCH/ca-key.pem" -out "$SCRATCH/ca-cert.pem" \
  -subj "/CN=ozaco-nats-test-ca" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -keyout "$SCRATCH/server-key.pem" -out "$SCRATCH/server.csr" \
  -subj "/CN=localhost" >/dev/null 2>&1
openssl x509 -req -in "$SCRATCH/server.csr" -CA "$SCRATCH/ca-cert.pem" \
  -CAkey "$SCRATCH/ca-key.pem" -CAcreateserial -days 2 -out "$SCRATCH/server-cert.pem" \
  -extfile <(printf 'subjectAltName=DNS:localhost,IP:127.0.0.1') >/dev/null 2>&1
chmod 644 "$SCRATCH"/*.pem

# --- throwaway nkey user (nkeys ships inside @nats-io/nats-core — no global tools needed) ---
read -r NKEY_PUB NKEY_SEED <<<"$(bun -e '
  import { nkeys } from "@nats-io/nats-core"
  const user = nkeys.createUser()
  console.log(user.getPublicKey(), new TextDecoder().decode(user.getSeed()))
')"

cat >"$SCRATCH/nkey.conf" <<EOF
authorization {
  users [
    { nkey: "$NKEY_PUB" }
  ]
}
EOF

docker run -d --rm --name "$NAME" \
  -p 127.0.0.1:0:4222 "$IMAGE" -js >/dev/null
docker run -d --rm --name "$TLS_NAME" \
  -p 127.0.0.1:0:4222 -v "$SCRATCH:/scratch:ro" "$IMAGE" \
  -js --tls --tlscert /scratch/server-cert.pem --tlskey /scratch/server-key.pem >/dev/null
docker run -d --rm --name "$NKEY_NAME" \
  -p 127.0.0.1:0:4222 -v "$SCRATCH:/scratch:ro" "$IMAGE" \
  -c /scratch/nkey.conf -js >/dev/null

wait_ready() {
  for _ in $(seq 1 120); do
    # the server logs "Server is ready" once the listener (and JetStream) is up
    if docker logs "$1" 2>&1 | grep -q 'Server is ready'; then
      return 0
    fi
    sleep 0.25
  done

  echo "nats ($1) did not become ready in time" >&2
  docker logs "$1" >&2 || true
  return 1
}

wait_ready "$NAME"
wait_ready "$TLS_NAME"
wait_ready "$NKEY_NAME"

host_port() {
  docker port "$1" 4222/tcp | head -1 | awk -F: '{print $NF}'
}

PORT="$(host_port "$NAME")"
TLS_PORT="$(host_port "$TLS_NAME")"
NKEY_PORT="$(host_port "$NKEY_NAME")"

SERVER_TEST_NATS_URL="nats://127.0.0.1:${PORT}" \
  SERVER_TEST_NATS_TLS_URL="tls://127.0.0.1:${TLS_PORT}" \
  SERVER_TEST_NATS_TLS_CA="${SCRATCH}/ca-cert.pem" \
  SERVER_TEST_NATS_NKEY_URL="nats://127.0.0.1:${NKEY_PORT}" \
  SERVER_TEST_NATS_NKEY_SEED="${NKEY_SEED}" \
  bun test tests/transport/nats.test.ts "$@"
