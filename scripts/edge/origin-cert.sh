#!/usr/bin/env bash
# The certificate each door presents to its edge (ADR-0165 point 4, hosting O13).
# No door's certificate is renewed online, so none needs the foreign internet.
#
#   origin-cert.sh domestic <domain>   our origin CA (made once) signs a 10-year
#                                      certificate for <domain> and *.<domain>,
#                                      the domestic door's (NIN-1-c1)
#   origin-cert.sh show                each door's certificate: names, expiry
#
# Everything goes to dev-docker/secrets/origin-cert/. A door's pair is bound
# by its gateway, so it is sealed with the rest (contract.secrets.md S1); the
# CA's key is bound by nothing and never leaves the host that made it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEYS="${ORIGIN_CERT_KEYS:-$ROOT_DIR/dev-docker/secrets/origin-cert}"
# Arvan does not verify the domestic door's certificate (NIN-1-a), so its
# lifetime is ours to choose: one renewal a decade, alerted 30 days ahead.
DOMESTIC_DAYS=3650
# The CA outlives the certificates it signs, so one re-issued late still fits.
CA_DAYS=7300

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
  show) show ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
