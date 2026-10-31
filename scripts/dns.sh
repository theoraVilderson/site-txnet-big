#!/usr/bin/env bash
# The DNS resolvers of this host or production, from dev-docker/dns/resolvers.txt (NIN-1-l).
# The work is tools/dns_resolvers.py's; run as root from the checkout.
#   scripts/dns.sh check | set A [B ...] | apply [--prod] [--restart-docker]
set -euo pipefail
ROOT_DIR="$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
exec python3 "$ROOT_DIR/tools/dns_resolvers.py" "$@"
