#!/bin/sh
# Postgres backups with pgBackRest (OPS-1-b, ADR-0126, hosting/contract.md H3).
#
# A full on Sunday and a differential every other day, both at PG_BACKUP_AT
# (UTC, default 01:00). pgbackrest.conf keeps 2 fulls; each backup expires the
# older ones and their WAL. After every run it writes txnet_pg_backup_* to
# node-exporter's textfile directory, which database.rules.yml alerts on (H5).
#
# pgBackRest runs as postgres (uid 70): it reads the data volume, mounted read
# only, and reaches main-db over the shared socket volume. The loop stays root
# only to write the textfile directory it shares with object-backup.
#
# First start: stanza-create if missing, then a full at once when the
# repository holds no backup. A manual run:
#   docker exec txnet-pg-backup sh /usr/local/bin/pg-backup.sh full|diff
set -u

AT="${PG_BACKUP_AT:-01:00}"
FULL_WEEKDAY=7 # `date +%u`: Sunday
TEXTFILE_DIR="${TEXTFILE_DIR:-/textfile}"
METRICS="$TEXTFILE_DIR/pg_backup.prom"

# The last success survives a restart: it is read back from the file this writes.
LAST_OK=$(sed -n 's/^txnet_pg_backup_last_success_timestamp_seconds //p' "$METRICS" 2>/dev/null || true)

log() { echo "$(date -u +%FT%TZ) pg-backup: $*"; }

pgbr() { gosu postgres pgbackrest --stanza=txnet "$@"; }

record() {
  ok=$1
  type=$2
  [ "$ok" = 1 ] && LAST_OK=$(date +%s)
  tmp="$TEXTFILE_DIR/.pg_backup.prom.$$"
  {
    echo "# HELP txnet_pg_backup_last_run_success 1 when the last backup completed, else 0."
    echo "# TYPE txnet_pg_backup_last_run_success gauge"
    echo "txnet_pg_backup_last_run_success $ok"
    echo "# HELP txnet_pg_backup_last_run_timestamp_seconds When the last run ended."
    echo "# TYPE txnet_pg_backup_last_run_timestamp_seconds gauge"
    echo "txnet_pg_backup_last_run_timestamp_seconds $(date +%s)"
    echo "# HELP txnet_pg_backup_last_type The type of the last run: full or diff."
    echo "# TYPE txnet_pg_backup_last_type gauge"
    echo "txnet_pg_backup_last_type{type=\"$type\"} 1"
    if [ -n "$LAST_OK" ]; then
      echo "# HELP txnet_pg_backup_last_success_timestamp_seconds When a backup last succeeded."
      echo "# TYPE txnet_pg_backup_last_success_timestamp_seconds gauge"
      echo "txnet_pg_backup_last_success_timestamp_seconds $LAST_OK"
    fi
  } > "$tmp" && mv "$tmp" "$METRICS" || log "could not write $METRICS"
}

run() {
  type=$1
  log "starting $type"
  if pgbr --type="$type" backup; then
    record 1 "$type"
    log "$type done"
  else
    record 0 "$type"
    log "$type FAILED"
    return 1
  fi
}

todays_type() {
  if [ "$(date -u +%u)" = "$FULL_WEEKDAY" ]; then echo full; else echo diff; fi
}

has_backup() { pgbr info --output=json 2>/dev/null | grep -q '"label"'; }

sh /usr/local/bin/pgbackrest-repo.sh || exit 1

case "${1:-}" in
  full | diff)
    run "$1"
    exit $?
    ;;
  "") ;;
  *)
    echo "usage: pg-backup.sh [full|diff]" >&2
    exit 2
    ;;
esac

# stanza-create is a no-op on a valid stanza; until it works there is nothing
# to back up into, and that is a failed run the alert should see.
until pgbr stanza-create; do
  record 0 full
  log "stanza-create FAILED, retrying in 60s"
  sleep 60
done
has_backup || run full

last_day=""
while true; do
  if [ "$(date -u +%H:%M)" = "$AT" ] && [ "$(date -u +%F)" != "$last_day" ]; then
    last_day=$(date -u +%F)
    run "$(todays_type)"
  fi
  sleep 30
done
