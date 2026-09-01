#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
exec docker compose -p devtxnet \
  --env-file "$ROOT_DIR/.env" \
  --env-file "$ROOT_DIR/.env.dev" \
  -f "$ROOT_DIR/dev-docker/docker-compose.main.yml" "$@"