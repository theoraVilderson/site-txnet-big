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
#   docker exec txnet-pg-backup sh /usr/local/bin/pg-backup.sh full|diff|drill
#
# The restore drill (OPS-1-c, H4), Sunday at PG_RESTORE_DRILL_AT (06:00 UTC):
# restore the latest backup to /drill, start a throwaway Postgres on it, read
# the ledger and the users, delete it. Its metric has a file of its own so a
# backup run does not overwrite it.
set -u

AT="${PG_BACKUP_AT:-01:00}"
FULL_WEEKDAY=7 # `date +%u`: Sunday
TEXTFILE_DIR="${TEXTFILE_DIR:-/textfile}"
METRICS="$TEXTFILE_DIR/pg_backup.prom"
DRILL_AT="${PG_RESTORE_DRILL_AT:-06:00}"
DRILL_METRICS="$TEXTFILE_DIR/pg_restore_drill.prom"
DRILL_DIR=/drill
DRILL_PORT=55432
DRILL_SOCKET=/tmp/drill-socket
DRILL_READY_TIMEOUT_S=600
LIVE_SOCKET=/var/run/postgresql

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

# Backups are listed oldest first; lsn's "stop" is a quoted string, so only
# the timestamp's number matches.
latest_backup_stop() {
  pgbr info --output=json | grep -o '"stop":[0-9]*' | tail -1 | cut -d: -f2
}

record_drill() {
  ok=$1
  last_ok=$(sed -n 's/^txnet_pg_restore_drill_last_success_timestamp_seconds //p' "$DRILL_METRICS" 2>/dev/null || true)
  [ "$ok" = 1 ] && last_ok=$(date +%s)
  tmp="$TEXTFILE_DIR/.pg_restore_drill.prom.$$"
  {
    echo "# HELP txnet_pg_restore_drill_last_run_success 1 when the last restore drill passed, else 0."
    echo "# TYPE txnet_pg_restore_drill_last_run_success gauge"
    echo "txnet_pg_restore_drill_last_run_success $ok"
    if [ -n "$last_ok" ]; then
      echo "# HELP txnet_pg_restore_drill_last_success_timestamp_seconds When a restore drill last passed."
      echo "# TYPE txnet_pg_restore_drill_last_success_timestamp_seconds gauge"
      echo "txnet_pg_restore_drill_last_success_timestamp_seconds $last_ok"
    fi
  } > "$tmp" && mv "$tmp" "$DRILL_METRICS" || log "could not write $DRILL_METRICS"
}

drill_sql() {
  gosu postgres psql -h "$DRILL_SOCKET" -p "$DRILL_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "$1"
}

live_sql() {
  gosu postgres psql -h "$LIVE_SOCKET" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "$1"
}

# The newest ledger row's epoch, -1 when there is none; "createdAt" is UTC
# without a zone, so the bound is converted rather than the column (index).
ledger_max_sql() {
  echo "SELECT coalesce(extract(epoch FROM max(\"createdAt\"))::bigint, -1) FROM billing.wallet_transaction $1"
}

drill_cleanup() {
  gosu postgres pg_ctl -D "$DRILL_DIR" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DRILL_DIR" "$DRILL_SOCKET"
}

# Replays the archived WAL after the backup, so the drill proves the archive
# too. archive_mode=off: the throwaway server must never push to the repository.
drill_check() {
  stop=$(latest_backup_stop)
  [ -n "$stop" ] || { log "drill: no backup to restore"; return 1; }
  mkdir -p "$DRILL_DIR" "$DRILL_SOCKET" && chown postgres:postgres "$DRILL_DIR" "$DRILL_SOCKET" && chmod 700 "$DRILL_DIR" || return 1
  pgbr --pg1-path="$DRILL_DIR" restore || return 1
  gosu postgres pg_ctl -D "$DRILL_DIR" -l "$DRILL_DIR/drill.log" -t "$DRILL_READY_TIMEOUT_S" -w start \
    -o "-p $DRILL_PORT -k $DRILL_SOCKET -c listen_addresses='' -c archive_mode=off" || { tail -20 "$DRILL_DIR/drill.log"; return 1; }
  # The restore must hold every ledger row live main-db had when the backup
  # stopped — exact, so a quiet week is not a failed drill (H4, user 2026-10-14).
  expected=$(live_sql "$(ledger_max_sql "WHERE \"createdAt\" <= to_timestamp($stop) AT TIME ZONE 'UTC'")") || return 1
  # Recovery ends with a promotion; until then the server answers read-only and
  # that is enough for the two reads.
  ledger=$(drill_sql "$(ledger_max_sql '')") || return 1
  users=$(drill_sql 'SELECT count(*) FROM identity."user"') || return 1
  log "drill: backup stopped $stop, ledger restored $ledger, live at the backup $expected, users $users"
  [ "$ledger" -ge "$expected" ] || { log "drill: the restore is missing ledger rows the backup should hold"; return 1; }
}

drill() {
  log "starting drill"
  drill_cleanup
  if drill_check; then
    record_drill 1
    log "drill passed"
    drill_cleanup
  else
    record_drill 0
    log "drill FAILED"
    drill_cleanup
    return 1
  fi
}

sh /usr/local/bin/pgbackrest-repo.sh || exit 1

case "${1:-}" in
  full | diff)
    run "$1"
    exit $?
    ;;
  drill)
    drill
    exit $?
    ;;
  "") ;;
  *)
    echo "usage: pg-backup.sh [full|diff|drill]" >&2
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
last_drill_day=""
while true; do
  if [ "$(date -u +%H:%M)" = "$AT" ] && [ "$(date -u +%F)" != "$last_day" ]; then
    last_day=$(date -u +%F)
    run "$(todays_type)"
  fi
  if [ "$(date -u +%u)" = "$FULL_WEEKDAY" ] && [ "$(date -u +%H:%M)" = "$DRILL_AT" ] \
    && [ "$(date -u +%F)" != "$last_drill_day" ]; then
    last_drill_day=$(date -u +%F)
    drill
  fi
  sleep 30
done
