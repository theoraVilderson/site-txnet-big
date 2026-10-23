#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
. "$SCRIPT_DIR/moved-guard.sh"
moved_guard "$ROOT_DIR" "${1:-}"
exec docker compose -p devtxnet \
  --env-file "$ROOT_DIR/.env" \
  --env-file "$ROOT_DIR/.env.dev" \
  -f "$ROOT_DIR/dev-docker/docker-compose.main.yml" \
  -f "$ROOT_DIR/dev-docker/docker-compose.dev.yml" "$@"