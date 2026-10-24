#!/bin/sh
# Writes /etc/pgbackrest/conf.d/repo.conf from env (hosting/contract.md H2):
# where the repository is, its passphrase, and the role pgBackRest signs in as.
#
#   PG_BACKUP_REPO_TYPE   posix (default) | s3 | sftp
#     posix  the repository is /repo — a host bind of PG_BACKUP_LOCAL_DIR
#     s3     PG_BACKUP_S3_ENDPOINT / _BUCKET / _REGION / _KEY / _SECRET
#     sftp   PG_BACKUP_SFTP_HOST / _USER / _PATH, key in /run/secrets/pg-backup-sftp-key,
#            the server's host key in /run/secrets/pg-backup-sftp-known-hosts
#   PG_BACKUP_REPO2_S3_*  set the bucket and repo2 is S3 beside repo1 (K15, OPS-1-o-o):
#     _ENDPOINT / _BUCKET / _REGION / _KEY / _SECRET, _URI_STYLE (host | path),
#     PG_BACKUP_REPO2_LOCK_DAYS the bucket's object-lock days (default 30)
#   POSTGRES_USER         the superuser; pgBackRest connects as it over the socket
#
# A file, not exported env: `docker exec … pgbackrest` must see the same
# settings as archive_command, and the passphrase stays out of the process
# environment (ADR-0026). Shared by main-db and pg-backup (H3).
set -eu

# Overridable only so test_pgbackrest_repo.py can run this outside the image.
PASSPHRASE_FILE="${PG_BACKUP_PASSPHRASE_FILE:-/run/secrets/pg-backup-passphrase}"
CONF="${PGBACKREST_REPO_CONF:-/etc/pgbackrest/conf.d/repo.conf}"
LOCK_DAYS="${PG_BACKUP_REPO2_LOCK_DAYS:-30}"
# An S3 outage must never stop Postgres (user, 2026-10-24): past this much WAL
# waiting to be pushed, pgBackRest acknowledges and drops it — a gap in point-in-time
# recovery that PgArchiveFailing reports and the next backup closes — instead of
# pg_wal filling the 50 GiB data disk (~23 GiB a day at archive_timeout=60).
ARCHIVE_QUEUE_MAX=8GiB

[ -s "$PASSPHRASE_FILE" ] || {
  echo "pgbackrest-repo: $PASSPHRASE_FILE is missing or empty — see dev-docker/secrets/README.md" >&2
  exit 1
}

repo_settings() {
  case "${PG_BACKUP_REPO_TYPE:-posix}" in
    posix)
      echo "repo1-type=posix"
      echo "repo1-path=/repo"
      ;;
    s3)
      echo "repo1-type=s3"
      echo "repo1-path=/txnet"
      echo "repo1-s3-endpoint=${PG_BACKUP_S3_ENDPOINT:?PG_BACKUP_S3_ENDPOINT is not set}"
      echo "repo1-s3-bucket=${PG_BACKUP_S3_BUCKET:?PG_BACKUP_S3_BUCKET is not set}"
      echo "repo1-s3-region=${PG_BACKUP_S3_REGION:?PG_BACKUP_S3_REGION is not set}"
      echo "repo1-s3-key=${PG_BACKUP_S3_KEY:?PG_BACKUP_S3_KEY is not set}"
      echo "repo1-s3-key-secret=${PG_BACKUP_S3_SECRET:?PG_BACKUP_S3_SECRET is not set}"
      ;;
    sftp)
      echo "repo1-type=sftp"
      echo "repo1-path=${PG_BACKUP_SFTP_PATH:?PG_BACKUP_SFTP_PATH is not set}"
      echo "repo1-sftp-host=${PG_BACKUP_SFTP_HOST:?PG_BACKUP_SFTP_HOST is not set}"
      echo "repo1-sftp-host-user=${PG_BACKUP_SFTP_USER:?PG_BACKUP_SFTP_USER is not set}"
      echo "repo1-sftp-private-key-file=/run/secrets/pg-backup-sftp-key"
      echo "repo1-sftp-known-host=/run/secrets/pg-backup-sftp-known-hosts"
      ;;
    *)
      echo "pgbackrest-repo: PG_BACKUP_REPO_TYPE='$PG_BACKUP_REPO_TYPE' — expected posix, s3 or sftp" >&2
      return 1
      ;;
  esac
}

# K15: the bucket has object lock in compliance mode for LOCK_DAYS. Retention by
# time keeps every full younger than that, so expire only ever deletes what the
# lock has released; a key that can delete still cannot destroy a locked version.
repo2_settings() {
  [ -n "${PG_BACKUP_REPO2_S3_BUCKET:-}" ] || return 0
  echo "repo2-type=s3"
  echo "repo2-path=/txnet"
  echo "repo2-s3-endpoint=${PG_BACKUP_REPO2_S3_ENDPOINT:?PG_BACKUP_REPO2_S3_ENDPOINT is not set}"
  echo "repo2-s3-bucket=$PG_BACKUP_REPO2_S3_BUCKET"
  echo "repo2-s3-region=${PG_BACKUP_REPO2_S3_REGION:?PG_BACKUP_REPO2_S3_REGION is not set}"
  echo "repo2-s3-key=${PG_BACKUP_REPO2_S3_KEY:?PG_BACKUP_REPO2_S3_KEY is not set}"
  echo "repo2-s3-key-secret=${PG_BACKUP_REPO2_S3_SECRET:?PG_BACKUP_REPO2_S3_SECRET is not set}"
  echo "repo2-s3-uri-style=${PG_BACKUP_REPO2_S3_URI_STYLE:-host}"
  echo "repo2-cipher-type=aes-256-cbc"
  echo "repo2-cipher-pass=$1"
  echo "repo2-retention-full-type=time"
  echo "repo2-retention-full=$LOCK_DAYS"
  echo "archive-async=y"
  echo "archive-push-queue-max=$ARCHIVE_QUEUE_MAX"
}

mkdir -p "$(dirname "$CONF")"
umask 077
passphrase="$(cat "$PASSPHRASE_FILE")"
# Settings first, so a missing variable fails before anything is written.
repo2="$(repo2_settings "$passphrase")"
{
  echo "[global]"
  repo_settings
  echo "repo1-cipher-pass=$passphrase"
  [ -z "$repo2" ] || echo "$repo2"
  echo
  echo "[txnet]"
  echo "pg1-user=${POSTGRES_USER:?POSTGRES_USER is not set}"
} > "$CONF.tmp"
mv "$CONF.tmp" "$CONF"

# Run as root at start: postgres (uid 70) archives, so it owns the config and,
# on posix, the host directory docker created as root. The image always has the
# user; a host running the test does not.
if [ "$(id -u)" = 0 ] && id postgres >/dev/null 2>&1; then
  chown postgres:postgres "$CONF"
  [ "${PG_BACKUP_REPO_TYPE:-posix}" = posix ] && chown postgres:postgres /repo
fi
exit 0
