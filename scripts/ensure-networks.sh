#!/usr/bin/env bash
# Ensure required Docker networks exist for dev (bridge) and prod (overlay)

set -euo pipefail

ensure_bridge() {
  name="$1"
  if docker network ls --filter name="^${name}$" --format '{{.Name}}' | grep -q "^${name}$"; then
    echo "Bridge network '${name}' exists"
  else
    docker network create --driver bridge "${name}"
    echo "Created bridge network '${name}'"
  fi
}

ensure_overlay() {
  name="$1"
  if docker network ls --filter name="^${name}$" --format '{{.Name}}' | grep -q "^${name}$"; then
    echo "Overlay network '${name}' exists"
  else
    docker network create --driver overlay --attachable "${name}"
    echo "Created overlay network '${name}'"
  fi
}

case "${1:-}" in
  dev)
    ensure_bridge public_gateway_network
    ensure_bridge private_backend_network
    ;;
  prod)
    ensure_overlay public_gateway_network
    ensure_overlay private_backend_network
    ;;
  *)
    echo "Usage: $0 {dev|prod}"
    exit 2
    ;;
esac
