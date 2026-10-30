#!/bin/sh
# Nightly locked copy of every stored file (F-018-m2-c; was restic, F-414-m, ADR-0120).
#
# Mirrors the files — the bucket on the `s3` driver, the volume on `local` —
# into the backup bucket under OBJECT_BACKUP_S3_PREFIX: new and changed files
# copied, removed ones marked deleted. Then every current copy's compliance
# lock is renewed for OBJECT_BACKUP_S3_LOCK_DAYS, set on each object because
# Arvan does not apply a bucket's default (B7). So whoever holds the key can
# hide a copy but not erase it: a deleted file's last version stays at least
# that long, then the bucket's noncurrent rule removes it. After every run it
# writes txnet_object_backup_* to node-exporter's textfile directory, which
# `storage.rules.yml` alerts on — a run that fails, or none for 36 hours.
#
#   OBJECT_BACKUP_AT       HH:MM, UTC, when the nightly run starts (default 23:00)
#   OBJECT_BACKUP_S3_*     the backup bucket: _ENDPOINT, _BUCKET, _ACCESS_KEY_ID,
#                          _SECRET_ACCESS_KEY, _PREFIX (objects/<stack>/), _LOCK_DAYS
#   OBJECT_STORAGE_DRIVER  `s3` reads OBJECT_STORAGE_S3_*; `local` reads /data/objects
# Unset, every run fails and says so, and ObjectBackupStale fires: a server
# whose files have no copy off it is an alert, not a silence.
#
# The first start with no success on record runs at once. A manual run:
#   docker exec txnet-object-backup sh /usr/local/bin/object-backup.sh --now
set -u

AT="${OBJECT_BACKUP_AT:-23:00}"
VOLUME=/data/objects
TEXTFILE_DIR="${TEXTFILE_DIR:-/textfile}"
METRICS="$TEXTFILE_DIR/object_backup.prom"
export MC_CONFIG_DIR=/tmp/mc

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
    echo "# HELP txnet_object_backup_last_run_success 1 when the last run copied and locked every file, else 0."
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

# The aliases. `mc alias set` takes each key as an argument inside this container only.
aliases() {
  for name in OBJECT_BACKUP_S3_ENDPOINT OBJECT_BACKUP_S3_BUCKET OBJECT_BACKUP_S3_ACCESS_KEY_ID \
              OBJECT_BACKUP_S3_SECRET_ACCESS_KEY OBJECT_BACKUP_S3_PREFIX OBJECT_BACKUP_S3_LOCK_DAYS; do
    eval "value=\${$name:-}"
    [ -n "$value" ] || { log "$name is not set: no backup bucket"; return 1; }
  done
  mc alias set dst "$OBJECT_BACKUP_S3_ENDPOINT" "$OBJECT_BACKUP_S3_ACCESS_KEY_ID" "$OBJECT_BACKUP_S3_SECRET_ACCESS_KEY" >/dev/null || return 1
  DST="dst/$OBJECT_BACKUP_S3_BUCKET/${OBJECT_BACKUP_S3_PREFIX%/}"
  if [ "${OBJECT_STORAGE_DRIVER:-local}" = s3 ]; then
    mc alias set src "$OBJECT_STORAGE_S3_ENDPOINT" "$OBJECT_STORAGE_S3_ACCESS_KEY_ID" "$OBJECT_STORAGE_S3_SECRET_ACCESS_KEY" >/dev/null || return 1
    SRC="src/$OBJECT_STORAGE_S3_BUCKET"
  else
    SRC="$VOLUME"
  fi
}

# --remove would mark every copy deleted if the source read as empty (a wrong
# driver, an unmounted volume): an empty source beside a full backup stops.
looks_lost() {
  [ -z "$(mc ls --recursive "$SRC" 2>/dev/null | head -1)" ] && [ -n "$(mc ls --recursive "$DST" 2>/dev/null | head -1)" ]
}

backup() {
  aliases || return 1
  if looks_lost; then log "$SRC is empty and $DST is not: refusing to mark every copy deleted"; return 1; fi
  mc mirror --overwrite --remove --exclude '*.tmp' --quiet "$SRC" "$DST" || return 1
  [ "$OBJECT_BACKUP_S3_LOCK_DAYS" = 0 ] && return 0
  mc retention set --recursive --quiet compliance "${OBJECT_BACKUP_S3_LOCK_DAYS}d" "$DST" >/dev/null || return 1
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
