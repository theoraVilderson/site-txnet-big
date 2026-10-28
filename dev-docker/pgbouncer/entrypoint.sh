#!/bin/sh
# db-pool's entrypoint (OPS-1-h, H7): write pgbouncer.ini and userlist.txt to
# the tmpfs at /run/pgbouncer, then run PgBouncer as its own user. The
# passwords stay off disk and out of the image; PgBouncer needs them in plain
# text to answer SCRAM from the client and to start SCRAM towards main-db.
set -eu

: "${MAIN_DB_NAME:?MAIN_DB_NAME is not set}"
: "${DB_APP_PASSWORD:?DB_APP_PASSWORD is not set}"
: "${DB_CROSS_TENANT_PASSWORD:?DB_CROSS_TENANT_PASSWORD is not set}"
: "${DB_AI_READER_PASSWORD:?DB_AI_READER_PASSWORD is not set}"

DIR=/run/pgbouncer
umask 077

# userlist.txt quotes each field and doubles a `"` inside it.
entry() {
  printf '"%s" "%s"\n' "$1" "$(printf '%s' "$2" | sed 's/"/""/g')"
}
{
  entry txnet_app_user "$DB_APP_PASSWORD"
  entry txnet_cross_tenant_user "$DB_CROSS_TENANT_PASSWORD"
  entry txnet_ai_reader_user "$DB_AI_READER_PASSWORD"
} > "$DIR/userlist.txt"

# Values are hosting H7's; a change there is a change here. server_reset_query
# is empty because transaction mode never hands a session over (C-41), and the
# two ignored startup parameters are the ones pgx and Prisma send.
# default_transaction_read_only is tracked, not ignored: sub-service opens
# every connection read-only (ADR-0082 (1)) and PgBouncer would refuse the
# startup parameter; tracked, it is restored on each server connection that
# client is given and on no other client's. server_login_retry is 2 s, not the
# default 15: after a failed login PgBouncer refuses every client until it
# retries, so a main-db restart cost 15 s more and crashed services booting in
# that window (LIVE-1-s, 2026-10-28).
cat > "$DIR/pgbouncer.ini" <<INI
[databases]
${MAIN_DB_NAME} = host=main-db port=5432 dbname=${MAIN_DB_NAME}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
unix_socket_dir =
auth_type = scram-sha-256
auth_file = ${DIR}/userlist.txt
pool_mode = transaction
max_client_conn = 2000
default_pool_size = 20
reserve_pool_size = 5
reserve_pool_timeout = 3
max_prepared_statements = 200
server_reset_query =
ignore_startup_parameters = extra_float_digits,options
server_idle_timeout = 300
server_login_retry = 2
track_extra_parameters = IntervalStyle, default_transaction_read_only
INI

chown -R pgbouncer:pgbouncer "$DIR"
exec su-exec pgbouncer pgbouncer "$DIR/pgbouncer.ini"
