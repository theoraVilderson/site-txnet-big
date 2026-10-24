#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
. "$SCRIPT_DIR/moved-guard.sh"
moved_guard "$ROOT_DIR" "${1:-}"

# OPS-1-o-v: a bind keeps the host file's mode, and the prod images run as their
# own user (`node`), so each secret file a compose service binds is 0644 — as
# Kubernetes mounts its Secret (K7). The directory stays root's alone, so the
# host's other users still read none of them.
SECRETS_DIR="$ROOT_DIR/dev-docker/secrets"
if [ -d "$SECRETS_DIR" ]; then
  chmod 0700 "$SECRETS_DIR"
  grep -ohE '\./secrets/[A-Za-z0-9._-]+:' "$ROOT_DIR"/dev-docker/compose/*.yml | sort -u |
    while IFS= read -r bound; do
      bound="${bound#./secrets/}"
      [ ! -f "$SECRETS_DIR/${bound%:}" ] || chmod 0644 "$SECRETS_DIR/${bound%:}"
    done
fi

exec docker compose -p prodtxnet \
  --env-file "$ROOT_DIR/.env" \
  --env-file "$ROOT_DIR/.env.prod" \
  -f "$ROOT_DIR/dev-docker/docker-compose.main.yml" "$@"
