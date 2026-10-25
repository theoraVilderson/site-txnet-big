#!/usr/bin/env bash
# The certificate each door presents to its edge (ADR-0165 point 4, hosting O13).
# No door's certificate is renewed online, so none needs the foreign internet.
#
#   origin-cert.sh domestic <domain>   our origin CA (made once) signs a 10-year
#                                      certificate for <domain> and *.<domain>,
#                                      the domestic door's (NIN-1-c1)
#   origin-cert.sh cloudflare          Cloudflare's Origin CA signs our CSR for
#                                      $DOMAIN_NAME and *.$DOMAIN_NAME, 15 years:
#                                      the 443 door's (NIN-1-c2)
#   origin-cert.sh strict              the zone to Full (strict): Cloudflare
#                                      verifies that certificate on every pull
#   origin-cert.sh show                each door's certificate: names, expiry
#
# Everything goes to dev-docker/secrets/origin-cert/. A door's pair is bound
# by its gateway, so it is sealed with the rest (contract.secrets.md S1); the
# CA's key is bound by nothing and never leaves the host that made it.
# `cloudflare` and `strict` read CLOUDFLARE_API_TOKEN (Zone / SSL and
# Certificates / Edit, the EDGE-1-c token), CLOUDFLARE_ZONE_ID and DOMAIN_NAME
# from the environment, or from the env file named by ENV_FILE.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEYS="${ORIGIN_CERT_KEYS:-$ROOT_DIR/dev-docker/secrets/origin-cert}"
# Arvan does not verify the domestic door's certificate (NIN-1-a), so its
# lifetime is ours to choose: one renewal a decade, alerted 30 days ahead.
DOMESTIC_DAYS=3650
# The CA outlives the certificates it signs, so one re-issued late still fits.
CA_DAYS=7300
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

ca() {
  [[ -f "$KEYS/ca.key" ]] && return
  openssl req -x509 -newkey rsa:2048 -nodes -days "$CA_DAYS" -subj "/O=TXNet/CN=TXNet origin CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$KEYS/ca.key" -out "$KEYS/ca.pem" 2>/dev/null
}

domestic() { # domain
  local domain="${1:?usage: origin-cert.sh domestic <domain>}"
  mkdir -p "$KEYS"
  refuse_existing "$KEYS/domestic.pem"
  umask 077
  ca
  openssl req -newkey rsa:2048 -nodes -subj "/O=TXNet/CN=$domain" \
    -keyout "$KEYS/domestic.key" -out "$KEYS/domestic.csr" 2>/dev/null
  openssl x509 -req -in "$KEYS/domestic.csr" -CA "$KEYS/ca.pem" -CAkey "$KEYS/ca.key" -CAcreateserial \
    -days "$DOMESTIC_DAYS" -out "$KEYS/domestic.pem" \
    -extfile <(printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:%s,DNS:*.%s\n' "$domain" "$domain") 2>/dev/null
  rm -f "$KEYS/domestic.csr" "$KEYS/ca.srl"
  openssl verify -CAfile "$KEYS/ca.pem" "$KEYS/domestic.pem"
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
  domestic) domestic "${2:-}" ;;
  cloudflare) cloudflare ;;
  strict) strict ;;
  show) show ;;
  *) sed -n '2,21p' "$0"; exit 2 ;;
esac
