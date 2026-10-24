# shellcheck shell=bash
# Sourced by dev.compose.sh and prod.compose.sh (OPS-1-ac, hosting H23).
# After a server move this host's volumes are a stale copy, and a second
# Postgres archiving into the same pgBackRest repository forks it: a command
# that starts the stack is refused while the marker is here. Reading
# commands (ps, logs, config) still work. TXNET_MOVED_OK=1 is the rollback.
moved_guard() {
  local marker="$1/.moved-to" verb="${2:-}"
  [ -f "$marker" ] || return 0
  [ "${TXNET_MOVED_OK:-}" = 1 ] && return 0
  case "$verb" in
    up | start | restart | create | run)
      echo "refused: this stack was moved to $(cat "$marker") — see docs/operations/runbook-move-server.md" >&2
      exit 1
      ;;
  esac
}
