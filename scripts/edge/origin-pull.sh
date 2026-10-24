#!/usr/bin/env bash
# Our own Authenticated Origin Pulls certificate (ADR-0129 amendment 1, EDGE-1-g).
#
#   origin-pull.sh issue    ca.pem into dev-docker/traefik/origin-pull/ (the gateway
#                           mounts that folder), the keys and the client
#                           certificate into dev-docker/secrets/origin-pull/
#   origin-pull.sh upload   the client pair -> the zone, then AOP on
#   origin-pull.sh status   what the zone holds
#
# Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID from the environment, or
# from the env file named by ENV_FILE (e.g. ENV_FILE=.env.prod).
# The gateway trusts ca.pem alone, so Cloudflare's shared origin-pull
# certificate — which any Cloudflare customer can make it send — is refused.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="${ORIGIN_PULL_DIR:-$ROOT_DIR/dev-docker/traefik/origin-pull}"
KEYS="${ORIGIN_PULL_KEYS:-$ROOT_DIR/dev-docker/secrets/origin-pull}"
API="https://api.cloudflare.com/client/v4"

load_env() {
  # shellcheck source=/dev/null # ENV_FILE is the caller's choice (.env.prod, ...)
  if [[ -n "${ENV_FILE:-}" ]]; then set -a; . "$ROOT_DIR/$ENV_FILE"; set +a; fi
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (or ENV_FILE)}"
  : "${CLOUDFLARE_ZONE_ID:?set CLOUDFLARE_ZONE_ID (or ENV_FILE)}"
}

cf() { # method path [json]
  curl -sS -m 30 -X "$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'Content-Type: application/json' ${3:+--data "$3"} \
    "$API/zones/$CLOUDFLARE_ZONE_ID/$2"
}

ok() { # fail loudly on an API refusal
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get("result"), indent=1)); sys.exit(0 if d.get("success") else (print(d.get("errors"), file=sys.stderr) or 1))'
}

issue() {
  mkdir -p "$DIR" "$KEYS"
  if [[ -f "$DIR/ca.pem" && "${FORCE:-}" != 1 ]]; then
    echo "$DIR/ca.pem exists; FORCE=1 to replace (the gateway and the zone must then both change)" >&2
    exit 1
  fi
  umask 077
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/O=TXNet/CN=TXNet origin-pull CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$KEYS/ca.key" -out "$DIR/ca.pem" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/O=TXNet/CN=Cloudflare origin pull" \
    -keyout "$KEYS/client.key" -out "$KEYS/client.csr" 2>/dev/null
  openssl x509 -req -in "$KEYS/client.csr" -CA "$DIR/ca.pem" -CAkey "$KEYS/ca.key" -CAcreateserial \
    -days 1825 -out "$KEYS/client.pem" \
    -extfile <(printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n') 2>/dev/null
  rm -f "$KEYS/client.csr" "$DIR/ca.srl"
  chmod 644 "$DIR/ca.pem"
  openssl verify -CAfile "$DIR/ca.pem" "$KEYS/client.pem"
}

upload() {
  load_env
  local body
  body=$(python3 -c 'import json,sys; print(json.dumps({"certificate": open(sys.argv[1]).read(), "private_key": open(sys.argv[2]).read()}))' \
    "$KEYS/client.pem" "$KEYS/client.key")
  cf POST origin_tls_client_auth "$body" | ok
  cf PUT origin_tls_client_auth/settings '{"enabled":true}' | ok
}

status() {
  load_env
  cf GET origin_tls_client_auth/settings | ok
  cf GET origin_tls_client_auth | ok
}

case "${1:-}" in
  issue) issue ;;
  upload) upload ;;
  status) status ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac
