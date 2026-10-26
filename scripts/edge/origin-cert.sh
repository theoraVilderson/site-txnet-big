#!/usr/bin/env bash
# The certificate the origin presents to its edges (ADR-0165 point 4, hosting O13).
# It is never renewed online, so it needs no foreign internet. One for every
# edge (NIN-1-b4): Arvan verifies none (NIN-1-a), Cloudflare verifies this one.
#
#   origin-cert.sh cloudflare          Cloudflare's Origin CA signs our CSR for
#                                      $DOMAIN_NAME and *.$DOMAIN_NAME, 15 years
#                                      (NIN-1-c2)
#   origin-cert.sh strict              the zone to Full (strict): Cloudflare
#                                      verifies that certificate on every pull
#   origin-cert.sh show                the certificate: names, expiry
#
# Everything goes to dev-docker/secrets/origin-cert/. The pair is bound by the
# gateway, so it is sealed with the rest (contract.secrets.md S1).
# `cloudflare` and `strict` read CLOUDFLARE_API_TOKEN (Zone / SSL and
# Certificates / Edit, the EDGE-1-c token), CLOUDFLARE_ZONE_ID and DOMAIN_NAME
# from the environment, or from the env file named by ENV_FILE.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEYS="${ORIGIN_CERT_KEYS:-$ROOT_DIR/dev-docker/secrets/origin-cert}"
# The longest Cloudflare's Origin CA signs (ADR-0165 point 4).
CLOUDFLARE_DAYS=5475
API="https://api.cloudflare.com/client/v4"

load_env() {
  # shellcheck source=/dev/null # ENV_FILE is the caller's choice (.env.prod, ...)
  if [[ -n "${ENV_FILE:-}" ]]; then set -a; . "$ROOT_DIR/$ENV_FILE"; set +a; fi
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (or ENV_FILE)}"
  : "${CLOUDFLARE_ZONE_ID:?set CLOUDFLARE_ZONE_ID (or ENV_FILE)}"
  : "${DOMAIN_NAME:?set DOMAIN_NAME (or ENV_FILE)}"
}

cf() { # method path body-file
  curl -sS -m 60 -X "$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'Content-Type: application/json' --data "@$3" "$API/$2"
}

# The answer's result printed, or its errors and a failure.
ok() {
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get("result"), indent=1)); sys.exit(0 if d.get("success") else (print(d.get("errors"), file=sys.stderr) or 1))'
}

refuse_existing() { # file
  if [[ -f "$1" && "${FORCE:-}" != 1 ]]; then
    echo "$1 exists; FORCE=1 to replace it (then seal it and deploy)" >&2
    exit 1
  fi
}

cloudflare() {
  load_env
  mkdir -p "$KEYS"
  refuse_existing "$KEYS/cloudflare.pem"
  umask 077
  local work answer
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  openssl req -newkey rsa:2048 -nodes -subj "/O=TXNet/CN=$DOMAIN_NAME" \
    -keyout "$work/cloudflare.key" -out "$work/cloudflare.csr" 2>/dev/null
  python3 -c 'import json,sys; print(json.dumps({"hostnames": [sys.argv[2], "*." + sys.argv[2]], "request_type": "origin-rsa", "requested_validity": int(sys.argv[3]), "csr": open(sys.argv[1]).read()}))' \
    "$work/cloudflare.csr" "$DOMAIN_NAME" "$CLOUDFLARE_DAYS" >"$work/request.json"
  answer="$(cf POST certificates "$work/request.json")"
  # Nothing is written until Cloudflare signed: a refusal leaves no pair to seal.
  printf '%s' "$answer" | ok >/dev/null
  printf '%s' "$answer" | python3 -c 'import json,sys; sys.stdout.write(json.load(sys.stdin)["result"]["certificate"])' >"$work/cloudflare.pem"
  mv "$work/cloudflare.key" "$KEYS/cloudflare.key"
  mv "$work/cloudflare.pem" "$KEYS/cloudflare.pem"
  openssl x509 -in "$KEYS/cloudflare.pem" -noout -subject -enddate
}

strict() {
  load_env
  local body
  body="$(mktemp)"
  trap 'rm -f "$body"' RETURN
  echo '{"value":"strict"}' >"$body"
  cf PATCH "zones/$CLOUDFLARE_ZONE_ID/settings/ssl" "$body" | ok
}

show() {
  local cert
  for cert in "$KEYS"/*.pem; do
    [[ -f "$cert" ]] || continue
    echo "== $(basename "$cert" .pem)"
    openssl x509 -in "$cert" -noout -subject -enddate -ext subjectAltName 2>/dev/null
  done
}

case "${1:-}" in
  cloudflare) cloudflare ;;
  strict) strict ;;
  show) show ;;
  *) sed -n '2,17p' "$0"; exit 2 ;;
esac
