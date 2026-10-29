#!/usr/bin/env bash
# A release from the dev host to production, through the production twin (hosting R15, ADR-0166).
# The work is tools/release.py's; run as root from the checkout. `--until twin` proves without sending.
set -euo pipefail
ROOT_DIR="$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
exec python3 "$ROOT_DIR/tools/release.py" "$@"
