#!/usr/bin/env bash
#
# Provision a bot integration from the tokens still sitting in .env.dev (F-069).
#
# Why this exists: F-066-i moved every bot token into the credential vault and
# removed the four bot variables from the compose files, so `.env.dev` still
# holds them but nothing reads them any more. A `migrate reset` then empties
# `automation.bot_integration` and `tenant.tenant_credential`, and there is no
# other way to put a bot back — the surface that would is the tenant panel
# (F-018). This script closes that gap until F-018 exists.
#
# It deliberately renames each value to SEED_*: `TELEGRAM_BOT_TOKEN` and
# friends are in CREDENTIAL_ENV_VARS and are no longer graced, so auth-service
# refuses to boot when one is set. Passing them under their own names would
# make this script the hole in that guard.
#
#   scripts/seed-bot-integration.sh telegram
#   scripts/seed-bot-integration.sh bale
#   scripts/seed-bot-integration.sh telegram --tenant some_slug
#
# Idempotent: re-running keeps the existing webhook path and, when a value has
# not changed, the vault recognises it by fingerprint and burns no version.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

PLATFORM="${1:-}"
if [[ "$PLATFORM" != "telegram" && "$PLATFORM" != "bale" ]]; then
  echo "usage: $(basename "$0") <telegram|bale> [--tenant <slug>]" >&2
  exit 2
fi
shift

TENANT="platform_owner"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant) TENANT="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Read .env then .env.dev, the same order scripts/dev.compose.sh uses, so the
# dev overrides win. `set -a` exports what the files define without this script
# having to know their contents.
set -a
# shellcheck disable=SC1090
[[ -f "$ROOT_DIR/.env" ]] && source "$ROOT_DIR/.env"
# shellcheck disable=SC1090
[[ -f "$ROOT_DIR/.env.dev" ]] && source "$ROOT_DIR/.env.dev"
set +a

UPPER="$(echo "$PLATFORM" | tr '[:lower:]' '[:upper:]')"
TOKEN_VAR="${UPPER}_BOT_TOKEN"
USERNAME_VAR="${UPPER}_BOT_USERNAME"
SECRET_VAR="${UPPER}_WEBHOOK_SECRET"

TOKEN="${!TOKEN_VAR:-}"
USERNAME="${!USERNAME_VAR:-}"
SECRET="${!SECRET_VAR:-}"

if [[ -z "$TOKEN" || -z "$USERNAME" ]]; then
  echo "$TOKEN_VAR and $USERNAME_VAR must both be set in .env / .env.dev" >&2
  exit 1
fi

CONTAINER="${STACK_NAME:-txnet-dev}-auth-service"
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "container $CONTAINER is not running" >&2
  exit 1
fi

echo "provisioning $PLATFORM @${USERNAME#@} for tenant $TENANT ..."

# -e NAME=VALUE keeps every secret out of the argument list, so it never shows
# up in `docker inspect`, in this machine's process table, or in a shell history.
docker exec \
  -e "SEED_BOT_PLATFORM=$PLATFORM" \
  -e "SEED_BOT_USERNAME=$USERNAME" \
  -e "SEED_BOT_TOKEN=$TOKEN" \
  -e "SEED_BOT_WEBHOOK_SECRET=$SECRET" \
  -e "SEED_BOT_TENANT=$TENANT" \
  "$CONTAINER" node dist/auth-service/seed-bot-integration.js

echo
echo "done. Restart bot-service so BotWebhookRegistrar picks it up:"
echo "  scripts/dev.compose.sh restart bot-service"
