#!/usr/bin/env bash
# =============================================================================
# TXNet — Local Development Environment Setup & Start
# =============================================================================
# This script:
#   1. Creates shared external Docker networks (if they don't exist)
#   2. Starts independent services FIRST (monitoring, bug-tracker, registry)
#   3. Starts the main application stack LAST
#
# Usage:
#   chmod +x dev-setup.sh
#   ./dev-setup.sh up       # Start everything
#   ./dev-setup.sh down     # Stop everything
#   ./dev-setup.sh restart  # Restart everything
#   ./dev-setup.sh status   # Show running containers
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_ENV="${ROOT_DIR}/.env"

# ---- Colors ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log()  { echo -e "${GREEN}[TXNet]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*"; }
info() { echo -e "${CYAN}[INFO]${NC} $*"; }

# ---- Check prerequisites ----
check_prereqs() {
  if ! command -v docker &>/dev/null; then
    err "Docker is not installed. Please install Docker first."
    exit 1
  fi
  if ! docker compose version &>/dev/null; then
    err "Docker Compose plugin is not available. Please install it."
    exit 1
  fi
  if [ ! -f "$ROOT_ENV" ]; then
    warn "Root .env file not found at ${ROOT_ENV}"
    warn "Copy .env.example to .env and fill in your values:"
    warn "  cp ${ROOT_DIR}/.env.example ${ROOT_ENV}"
    exit 1
  fi
  log "Prerequisites OK"
}

# ---- Create shared networks ----
create_networks() {
  log "Creating shared Docker networks..."

  if ! docker network ls --filter name="^public_gateway_network$" --format '{{.Name}}' | grep -q "^public_gateway_network$"; then
    docker network create --driver bridge public_gateway_network
    log "  ✓ Created 'public_gateway_network' (bridge)"
  else
    info "  'public_gateway_network' already exists"
  fi

  if ! docker network ls --filter name="^private_backend_network$" --format '{{.Name}}' | grep -q "^private_backend_network$"; then
    docker network create --driver bridge private_backend_network
    log "  ✓ Created 'private_backend_network' (bridge)"
  else
    info "  'private_backend_network' already exists"
  fi
}

# ---- Start independent services ----
start_independent() {
  local action="${1:-up}"
  local detach_flag=""
  if [ "$action" = "up" ]; then
    detach_flag="-d"
  fi

  log "=============================================="
  log "  Starting INDEPENDENT Infrastructure Services"
  log "=============================================="

  # 1. Docker Registry
  log "▶ Starting Docker Registry..."
  (cd "${SCRIPT_DIR}/registry" && \
    docker compose --env-file .env -p txnet-registry -f docker-compose.registry.yml "$action" $detach_flag)
  log "  ✓ Registry started"

  # 2. System Monitor (Prometheus, Grafana, Loki, etc.)
  log "▶ Starting System Monitor..."
  (cd "${SCRIPT_DIR}/monitoring" && \
    docker compose --env-file .env.dev -p txnet-monitor -f docker-compose.sys-monitor.yml "$action" $detach_flag)
  log "  ✓ System Monitor started"

  # 3. Bug Tracker (Glitchtip)
  log "▶ Starting Bug Tracker..."
  (cd "${SCRIPT_DIR}/bug-tracker" && \
    docker compose --env-file .env.dev -p txnet-bugtracker -f docker-compose.bug-tracker.yml "$action" $detach_flag)
  log "  ✓ Bug Tracker started"
}

# ---- Start main application stack ----
start_main() {
  local action="${1:-up}"
  local detach_flag=""
  if [ "$action" = "up" ]; then
    detach_flag="-d"
  fi

  log "=============================================="
  log "  Starting MAIN Application Stack"
  log "=============================================="

  log "▶ Starting Main Stack (Traefik, Backends, Frontends, DBs)..."
  (cd "$ROOT_DIR" && \
    docker compose --env-file .env -p txnet-main -f "${SCRIPT_DIR}/docker-compose.main.yml" "$action" $detach_flag)
  log "  ✓ Main Stack started"
}

# ---- Stop everything ----
stop_all() {
  log "Stopping all TXNet services..."

  log "▶ Stopping Main Stack..."
  (cd "$ROOT_DIR" && \
    docker compose --env-file .env -p txnet-main -f "${SCRIPT_DIR}/docker-compose.main.yml" down) || true

  log "▶ Stopping Bug Tracker..."
  (cd "${SCRIPT_DIR}/bug-tracker" && \
    docker compose --env-file .env.dev -p txnet-bugtracker -f docker-compose.bug-tracker.yml down) || true

  log "▶ Stopping System Monitor..."
  (cd "${SCRIPT_DIR}/monitoring" && \
    docker compose --env-file .env.dev -p txnet-monitor -f docker-compose.sys-monitor.yml down) || true

  log "▶ Stopping Registry..."
  (cd "${SCRIPT_DIR}/registry" && \
    docker compose --env-file .env -p txnet-registry -f docker-compose.registry.yml down) || true

  log "All services stopped."
}

# ---- Show status ----
show_status() {
  echo ""
  log "=============================================="
  log "  TXNet Container Status"
  log "=============================================="
  echo ""
  docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" \
    --filter "name=txnet-" \
    --filter "name=txnet_"
  echo ""
  log "Networks:"
  docker network ls --filter "name=public_gateway_network" --filter "name=private_backend_network" \
    --format "  {{.Name}} ({{.Driver}})"
  echo ""
}

# ---- Main ----
main() {
  local cmd="${1:-up}"

  check_prereqs

  case "$cmd" in
    up)
      create_networks
      start_independent up
      start_main up
      echo ""
      log "=============================================="
      log "  🚀 TXNet Dev Environment is UP!"
      log "=============================================="
      echo ""
      show_status
      ;;
    down)
      stop_all
      ;;
    restart)
      stop_all
      create_networks
      start_independent up
      start_main up
      echo ""
      log "🔄 TXNet Dev Environment restarted!"
      show_status
      ;;
    status)
      show_status
      ;;
    *)
      echo "Usage: $0 {up|down|restart|status}"
      exit 1
      ;;
  esac
}

main "$@"