#!/usr/bin/env bash
# A release from the dev host to production, through the production twin (hosting R15, R19; ADR-0166, ADR-0168).
# The work is tools/release.py's; run as root from the checkout. Proves and stops; `approve` (the owner), then `send`.
set -euo pipefail
ROOT_DIR="$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
exec python3 "$ROOT_DIR/tools/release.py" "$@"
