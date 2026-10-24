#!/bin/sh
# Nightly restic backup of the object-storage volume (F-414-m, ADR-0120).
#
# Backs up /data/objects (the volume, mounted read-only) to RESTIC_REPOSITORY,
# then keeps 7 daily, 4 weekly and 6 monthly snapshots. After every run it
# writes txnet_object_backup_* to node-exporter's textfile directory, which
# `storage.rules.yml` alerts on — a run that fails, or none for 36 hours.
#
#   OBJECT_BACKUP_AT       HH:MM, UTC, when the nightly run starts (default 23:00)
#   RESTIC_REPOSITORY      where snapshots go: a path, s3:…, sftp:…, rest:…
#   RESTIC_PASSWORD_FILE   the repository's password; losing it loses every snapshot
#
# The first start with no success on record runs at once. A manual run:
#   docker exec txnet-object-backup sh /usr/local/bin/object-backup.sh --now
set -u

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/run/secrets/object-backup-password}"
AT="${OBJECT_BACKUP_AT:-23:00}"
SOURCE=/data/objects
TEXTFILE_DIR="${TEXTFILE_DIR:-/textfile}"
METRICS="$TEXTFILE_DIR/object_backup.prom"
HOST=txnet-objects

# The last success survives a restart: it is read back from the file this writes.
LAST_OK=$(sed -n 's/^txnet_object_backup_last_success_timestamp_seconds //p' "$METRICS" 2>/dev/null || true)

log() { echo "$(date -u +%FT%TZ) object-backup: $*"; }

# The container check (compose/health.yml loop-health, hosting H24): every pass
# of the loop beats, and a run marks itself busy, so a long run is not a hung loop.
beat() { touch /tmp/healthy; }
busy() { touch /tmp/busy; "$@"; rc=$?; rm -f /tmp/busy; beat; return $rc; }

record() {
  ok=$1
  [ "$ok" = 1 ] && LAST_OK=$(date +%s)
  tmp="$TEXTFILE_DIR/.object_backup.prom.$$"
  {
    echo "# HELP txnet_object_backup_last_run_success 1 when the last run backed up and pruned, else 0."
    echo "# TYPE txnet_object_backup_last_run_success gauge"
    echo "txnet_object_backup_last_run_success $ok"
    echo "# HELP txnet_object_backup_last_run_timestamp_seconds When the last run ended."
    echo "# TYPE txnet_object_backup_last_run_timestamp_seconds gauge"
    echo "txnet_object_backup_last_run_timestamp_seconds $(date +%s)"
    if [ -n "$LAST_OK" ]; then
      echo "# HELP txnet_object_backup_last_success_timestamp_seconds When a run last succeeded."
      echo "# TYPE txnet_object_backup_last_success_timestamp_seconds gauge"
      echo "txnet_object_backup_last_success_timestamp_seconds $LAST_OK"
    fi
  } > "$tmp" && mv "$tmp" "$METRICS" || log "could not write $METRICS"
}

# A partial snapshot (restic exit 3: a file could not be read) is a failure.
backup() {
  restic cat config >/dev/null 2>&1 || restic init || return 1
  restic backup "$SOURCE" --host "$HOST" --tag object_storage --exclude '*.tmp' --one-file-system || return 1
  restic forget --host "$HOST" --tag object_storage --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune || return 1
}

run() {
  log "starting"
  if backup; then
    record 1
    log "done"
  else
    record 0
    log "FAILED"
    return 1
  fi
}

if [ "${1:-}" = "--now" ]; then
  run
  exit $?
fi

beat
[ -z "$LAST_OK" ] && busy run
last_day=""
while true; do
  beat
  if [ "$(date -u +%H:%M)" = "$AT" ] && [ "$(date -u +%F)" != "$last_day" ]; then
    last_day=$(date -u +%F)
    busy run
  fi
  sleep 30
done
