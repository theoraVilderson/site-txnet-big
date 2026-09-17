#!/usr/bin/env bash
#
# Put an SMS line into a tenant's credential vault (F-018-a).
#
# SMS_API_KEY / SMS_SENDER left the environment with F-018-a: auth-service and
# notification-service refuse to boot holding either, and read the platform
# owner's `sms_api_key` / `sms_sender_line` from the vault instead. This moves
# the values from .env / .env.dev into the vault, once, after a deploy or a
# `migrate reset`. The tenant panel that would do it is F-018.
#
# The key is SMS_API_KEY, or SMS_USERNAME@SMS_PASS (the gateway's user@pass
# form); the sender is SMS_SENDER_PRIVATE. Each reaches the container as
# SEED_SMS_* for the reason seed-bot-integration.sh gives.
#
#   scripts/seed-sms-line.sh
#   scripts/seed-sms-line.sh --tenant some_slug
#
# Idempotent: an unchanged value burns no vault version.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

TENANT="platform_owner"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant) TENANT="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

set -a
# shellcheck disable=SC1090
[[ -f "$ROOT_DIR/.env" ]] && source "$ROOT_DIR/.env"
# shellcheck disable=SC1090
[[ -f "$ROOT_DIR/.env.dev" ]] && source "$ROOT_DIR/.env.dev"
set +a

KEY="${SMS_API_KEY:-}"
if [[ -z "$KEY" && -n "${SMS_USERNAME:-}" && -n "${SMS_PASS:-}" ]]; then
  KEY="${SMS_USERNAME}@${SMS_PASS}"
fi
if [[ -z "$KEY" ]]; then
  echo "set SMS_API_KEY, or SMS_USERNAME and SMS_PASS, in .env / .env.dev" >&2
  exit 1
fi

CONTAINER="${STACK_NAME:-txnet-dev}-auth-service"
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "container $CONTAINER is not running" >&2
  exit 1
fi

echo "storing the SMS line for tenant $TENANT ..."

# -e NAME=VALUE keeps the secret out of the argument list and shell history.
docker exec \
  -e "SEED_SMS_API_KEY=$KEY" \
  -e "SEED_SMS_SENDER=${SMS_SENDER_PRIVATE:-}" \
  -e "SEED_SMS_TENANT=$TENANT" \
  "$CONTAINER" node dist/auth-service/seed-sms-line.js

echo "done. OTP and campaign SMS read it on their next send."
