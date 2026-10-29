#!/usr/bin/env bash
# The production twin's cluster on the dev host (hosting R14, ADR-0166): up, import, status, down.
# The work is tools/k8s_staging.py's; run as root from the checkout.
set -euo pipefail
ROOT_DIR="$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
exec python3 "$ROOT_DIR/tools/k8s_staging.py" "$@"
