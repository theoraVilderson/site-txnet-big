#!/usr/bin/env bash
# Register (or show, or delete) the Telegram/Bale webhook for one environment.
#
#   scripts/set-bot-webhook.sh dev            # register both bots for dev
#   scripts/set-bot-webhook.sh prod telegram  # just one platform
#   scripts/set-bot-webhook.sh dev bale show
#   scripts/set-bot-webhook.sh dev telegram delete
#
# The URL is not configuration — it is derived from the public base and the
# platform's own webhook secret, exactly as auth-service serves it:
#   <base>/api/auth/bots/<platform>/webhook/<secret>
# where <base> is <PLATFORM>_WEBHOOK_PUBLIC_BASE, else BOT_WEBHOOK_PUBLIC_BASE,
# else https://api.<DOMAIN_NAME>.
# A bot token holds only ONE webhook, so dev and prod need separate bots.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

ENV_NAME="${1:-}"
PLATFORMS="${2:-telegram bale}"
ACTION="${3:-set}"

case "$ENV_NAME" in
  dev|prod) ;;
  *) echo "usage: $0 <dev|prod> [telegram|bale] [set|show|delete]" >&2; exit 2 ;;
esac

# Same order docker compose uses: shared file first, environment override wins.
set -a
# shellcheck disable=SC1090
source "$ROOT_DIR/.env"
source "$ROOT_DIR/.env.$ENV_NAME"
set +a

fail() { echo "  ✗ $1" >&2; FAILED=1; }
FAILED=0

for platform in $PLATFORMS; do
  case "$platform" in
    telegram)
      token="${TELEGRAM_BOT_TOKEN:-}"
      username="${TELEGRAM_BOT_USERNAME:-}"
      secret="${TELEGRAM_WEBHOOK_SECRET:-}"
      api="${TELEGRAM_API_BASE:-https://api.telegram.org}"
      deep="${TELEGRAM_DEEP_LINK_BASE:-https://t.me}"
      public_base="${TELEGRAM_WEBHOOK_PUBLIC_BASE:-}"
      ;;
    bale)
      token="${BALE_BOT_TOKEN:-}"
      username="${BALE_BOT_USERNAME:-}"
      secret="${BALE_WEBHOOK_SECRET:-}"
      api="${BALE_API_BASE:-https://tapi.bale.ai}"
      deep="${BALE_DEEP_LINK_BASE:-https://ble.ir}"
      public_base="${BALE_WEBHOOK_PUBLIC_BASE:-}"
      ;;
    *) echo "unknown platform: $platform" >&2; exit 2 ;;
  esac

  echo "[$ENV_NAME/$platform]"
  [ -n "$token" ]  || { fail "BOT_TOKEN is empty — the channel cannot even send a code"; continue; }
  [ -n "$secret" ] || { fail "WEBHOOK_SECRET is empty — no webhook route exists to register"; continue; }
  [ -n "$username" ] && echo "  deep link  $deep/$username?start=<token>" \
                     || echo "  ! BOT_USERNAME is empty — existing users still get codes, but nobody new can link"

  # Same order auth-service's BotWebhookRegistrar resolves it in: this
  # platform's own front door, then a shared one, then api.<DOMAIN_NAME>.
  base="${public_base:-${BOT_WEBHOOK_PUBLIC_BASE:-https://api.${DOMAIN_NAME}}}"
  url="${base%/}/api/auth/bots/${platform}/webhook/${secret}"

  case "$ACTION" in
    show)
      curl -sS "${api}/bot${token}/getWebhookInfo" && echo ;;
    delete)
      curl -sS "${api}/bot${token}/deleteWebhook" && echo ;;
    set)
      echo "  webhook    $url"
      # secret_token is a Telegram-only extra; auth-service checks it when
      # present and always checks the secret in the path, which is what Bale
      # can carry. An unsupported field is ignored by Bale.
      curl -sS -X POST "${api}/bot${token}/setWebhook" \
        -H 'Content-Type: application/json' \
        -d "{\"url\":\"${url}\",\"secret_token\":\"${secret}\",\"allowed_updates\":[\"message\"]}" \
        && echo ;;
    *) echo "unknown action: $ACTION" >&2; exit 2 ;;
  esac
done

exit "$FAILED"
