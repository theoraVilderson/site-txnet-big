#!/bin/sh
# Writes /etc/pgbackrest/conf.d/repo.conf from env (hosting/contract.md H2):
# where the repository is, its passphrase, and the role pgBackRest signs in as.
#
#   PG_BACKUP_REPO_TYPE   posix (default) | s3 | sftp
#     posix  the repository is /repo — a host bind of PG_BACKUP_LOCAL_DIR
#     s3     PG_BACKUP_S3_ENDPOINT / _BUCKET / _REGION / _KEY / _SECRET
#     sftp   PG_BACKUP_SFTP_HOST / _USER / _PATH, key in /run/secrets/pg-backup-sftp-key,
#            the server's host key in /run/secrets/pg-backup-sftp-known-hosts
#   POSTGRES_USER         the superuser; pgBackRest connects as it over the socket
#
# A file, not exported env: `docker exec … pgbackrest` must see the same
# settings as archive_command, and the passphrase stays out of the process
# environment (ADR-0026). Shared by main-db and pg-backup (H3).
set -eu

PASSPHRASE_FILE=/run/secrets/pg-backup-passphrase
CONF=/etc/pgbackrest/conf.d/repo.conf

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

mkdir -p "$(dirname "$CONF")"
umask 077
{
  echo "[global]"
  repo_settings
  echo "repo1-cipher-pass=$(cat "$PASSPHRASE_FILE")"
  echo
  echo "[txnet]"
  echo "pg1-user=${POSTGRES_USER:?POSTGRES_USER is not set}"
} > "$CONF.tmp"
mv "$CONF.tmp" "$CONF"

# Run as root at start: postgres (uid 70) archives, so it owns the config and,
# on posix, the host directory docker created as root.
if [ "$(id -u)" = 0 ]; then
  chown postgres:postgres "$CONF"
  [ "${PG_BACKUP_REPO_TYPE:-posix}" = posix ] && chown postgres:postgres /repo
fi
exit 0
