#!/bin/sh
# Postgres backups with pgBackRest (OPS-1-b, ADR-0126, hosting/contract.md H3).
#
# A full on Sunday and a differential every other day, both at PG_BACKUP_AT
# (UTC, default 01:00); a missed Sunday's full runs the next night (K20).
# pgbackrest.conf keeps 2 fulls; each backup expires the older ones and their WAL. After every run it writes txnet_pg_backup_* to
# node-exporter's textfile directory, which database.rules.yml alerts on (H5).
#
# pgBackRest runs as postgres (uid 70): it reads the data volume, mounted read
# only, and reaches main-db over the shared socket volume. The loop stays root
# only to write the textfile directory it shares with object-backup.
#
# Every run backs up each repository: repo1, and repo2 on S3 when its bucket is
# set (K15, OPS-1-o-o); the run's metric is 1 only when every one succeeded.
#
# First start: stanza-create if missing, then a full at once in each repository
# that holds no backup. A manual run:
#   docker exec txnet-pg-backup sh /usr/local/bin/pg-backup.sh full|diff|drill [repo]
#
# The restore drill (OPS-1-c, H4), Sunday at PG_RESTORE_DRILL_AT (06:00 UTC):
# restore the latest backup to /drill, start a throwaway Postgres on it, read
# the ledger and the users, delete it. Its metric has a file of its own so a
# backup run does not overwrite it.
#
# Every pass of the loop also writes the size and free space of the filesystem
# under the data volume to pg_data_fs.prom (OPS-1-d, H5): measured here, where
# the volume is mounted, PgWalDiskHigh finds Postgres's disk on any host.
set -u

AT="${PG_BACKUP_AT:-01:00}"
FULL_WEEKDAY=7 # `date +%u`: Sunday
FULL_MAX_AGE_DAYS=7
SECONDS_PER_DAY=86400
TEXTFILE_DIR="${TEXTFILE_DIR:-/textfile}"
METRICS="$TEXTFILE_DIR/pg_backup.prom"
DRILL_AT="${PG_RESTORE_DRILL_AT:-06:00}"
DRILL_METRICS="$TEXTFILE_DIR/pg_restore_drill.prom"
DRILL_DIR=/drill
DRILL_PORT=55432
DRILL_SOCKET=/tmp/drill-socket
DRILL_READY_TIMEOUT_S=600
LIVE_SOCKET=/var/run/postgresql
DATA_DIR=/var/lib/postgresql
DATA_FS_METRICS="$TEXTFILE_DIR/pg_data_fs.prom"

# The last success survives a restart: it is read back from the file this writes.
LAST_OK=$(sed -n 's/^txnet_pg_backup_last_success_timestamp_seconds //p' "$METRICS" 2>/dev/null || true)

log() { echo "$(date -u +%FT%TZ) pg-backup: $*"; }

pgbr() { gosu postgres pgbackrest --stanza=txnet "$@"; }

# pgbackrest-repo.sh writes repo2 exactly when this is set.
repos() { echo 1; [ -z "${PG_BACKUP_REPO2_S3_BUCKET:-}" ] || echo 2; }

# The container check (compose/health.yml loop-health, hosting H24): every pass
# of the loop beats, and a run marks itself busy, so a long run is not a hung loop.
beat() { touch /tmp/healthy; }
busy() { touch /tmp/busy; "$@"; rc=$?; rm -f /tmp/busy; beat; return $rc; }

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

backup_in() {
  log "starting $2 in repo$1"
  if pgbr --repo="$1" --type="$2" backup; then
    log "$2 in repo$1 done"
  else
    log "$2 in repo$1 FAILED"
    return 1
  fi
}

# type [repo...]: each named repository, or every one; one metric for the run,
# so an S3 that refuses the backup is a failed run the alert sees (H5).
run() {
  type=$1
  shift
  ok=1
  for repo in ${*:-$(repos)}; do
    backup_in "$repo" "$type" || ok=0
  done
  record "$ok" "$type"
  [ "$ok" = 1 ]
}

# weekday today newest-full-day (YYYYMMDD, empty for none): a night whose
# newest full is a week old takes a full, so a stack down on Sunday does not
# keep every WAL segment for another week (contract.backup.md K20).
backup_type() {
  [ "$1" = "$FULL_WEEKDAY" ] && { echo full; return; }
  [ -n "$3" ] || { echo full; return; }
  full_day=$(echo "$3" | sed 's/^\(....\)\(..\)\(..\)$/\1-\2-\3/')
  age=$((($(date -u -d "$2" +%s) - $(date -u -d "$full_day" +%s)) / SECONDS_PER_DAY))
  if [ "$age" -ge "$FULL_MAX_AGE_DAYS" ]; then echo full; else echo diff; fi
}

newest_full_day() {
  pgbr --repo="$1" info | sed -n 's/^ *full backup: \([0-9]\{8\}\)-.*/\1/p' | tail -1
}

# The stalest repository decides: a run backs up every repository with one type.
todays_type() {
  stalest=""
  for repo in $(repos); do
    day=$(newest_full_day "$repo")
    [ -n "$day" ] || { stalest=""; break; }
    [ -z "$stalest" ] || [ "$day" -lt "$stalest" ] && stalest=$day
  done
  backup_type "$(date -u +%u)" "$(date -u +%F)" "$stalest"
}

has_backup() { pgbr --repo="$1" info --output=json 2>/dev/null | grep -q '"label"'; }

# Backups are listed oldest first; lsn's "stop" is a quoted string, so only
# the timestamp's number matches.
latest_backup_stop() {
  pgbr --repo="$DRILL_REPO" info --output=json | grep -o '"stop":[0-9]*' | tail -1 | cut -d: -f2
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

# df's 1K blocks, printed whole: awk's default print turns a large number
# into 1.2e+11, which the textfile collector rejects.
record_data_fs() {
  tmp="$TEXTFILE_DIR/.pg_data_fs.prom.$$"
  df -Pk "$DATA_DIR" | awk 'NR == 2 {
    print "# HELP txnet_pg_data_fs_size_bytes Size of the filesystem under the Postgres data volume."
    print "# TYPE txnet_pg_data_fs_size_bytes gauge"
    printf "txnet_pg_data_fs_size_bytes %.0f\n", $2 * 1024
    print "# HELP txnet_pg_data_fs_avail_bytes Space Postgres can still write on that filesystem."
    print "# TYPE txnet_pg_data_fs_avail_bytes gauge"
    printf "txnet_pg_data_fs_avail_bytes %.0f\n", $4 * 1024
  }' > "$tmp" && [ -s "$tmp" ] && mv "$tmp" "$DATA_FS_METRICS" || { rm -f "$tmp"; log "could not write $DATA_FS_METRICS"; }
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
  pgbr --repo="$DRILL_REPO" --pg1-path="$DRILL_DIR" restore || return 1
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
  log "starting drill from repo$DRILL_REPO"
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

# test_pg_backup.py sources the functions above without running anything below.
[ -z "${PG_BACKUP_SOURCED:-}" ] || return 0

sh /usr/local/bin/pgbackrest-repo.sh || exit 1

case "${1:-}" in
  full | diff)
    run "$1"
    exit $?
    ;;
  drill)
    # repo1 on schedule; `drill 2` proves the S3 copy restores too (runbook)
    DRILL_REPO="${2:-1}"
    drill
    exit $?
    ;;
  "") ;;
  *)
    echo "usage: pg-backup.sh [full|diff|drill [repo]]" >&2
    exit 2
    ;;
esac

# stanza-create is a no-op on a valid stanza; until it works there is nothing
# to back up into, and that is a failed run the alert should see.
beat
until pgbr stanza-create; do
  record 0 full
  log "stanza-create FAILED, retrying in 60s"
  sleep 60
  beat
done
# a repository added later (repo2, OPS-1-o-o) gets its first full now, not on Sunday
empty=$(for repo in $(repos); do has_backup "$repo" || echo "$repo"; done)
[ -z "$empty" ] || busy run full $empty

last_day=""
last_drill_day=""
while true; do
  beat
  record_data_fs
  if [ "$(date -u +%H:%M)" = "$AT" ] && [ "$(date -u +%F)" != "$last_day" ]; then
    last_day=$(date -u +%F)
    busy run "$(todays_type)"
  fi
  if [ "$(date -u +%u)" = "$FULL_WEEKDAY" ] && [ "$(date -u +%H:%M)" = "$DRILL_AT" ] \
    && [ "$(date -u +%F)" != "$last_drill_day" ]; then
    last_drill_day=$(date -u +%F)
    DRILL_REPO=1
    busy drill
  fi
  sleep 30
done
