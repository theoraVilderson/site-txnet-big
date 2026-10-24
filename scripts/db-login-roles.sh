#!/usr/bin/env bash
# =============================================================================
# The two login roles Row-Level Security needs (F-066-m-a, catalog 20.2 layer 1)
# =============================================================================
# `20260909000500_row_level_security` creates the *group* roles `txnet_app` and
# `txnet_cross_tenant` and hangs the policies off them. It cannot create the
# login roles: those carry passwords, and a password does not belong in a file
# that is committed. This script is where they come from.
#
# Why login roles at all: RLS is not enforced against a superuser, nor against
# a table's own owner. `MAIN_DB_USERNAME` is both — it is what `prisma migrate`
# runs as — so a service connecting with it leaves every policy inert. These
# two roles own nothing and carry NOBYPASSRLS.
#
#   ./scripts/db-login-roles.sh
#
# Idempotent: safe to re-run, and re-running is how a password is rotated.
# The passwords are read by compose from `.env` + `.env.dev` (`.env.prod` with
# ENV_FILE=.env.prod; from ENV_DIR instead of the checkout when given), so they
# mean here exactly what they mean to the services. They reach psql on stdin,
# never in an argv, which `docker exec` and `kubectl exec` both expose.
#
#   DB_EXEC  runs one command inside main-db's container (default:
#            `docker exec -i ${MAIN_DB_CONTAINER:-txnet-dev-postgres}`);
#            `prod.k8s.sh deploy` passes `kubectl exec` (OPS-1-o-w)
#
# Required in the env files:
#   DB_APP_PASSWORD           -> role `txnet_app_user`,          DATABASE_APP_URL
#   DB_CROSS_TENANT_PASSWORD  -> role `txnet_cross_tenant_user`, DATABASE_CROSS_TENANT_URL
#   DB_AI_READER_PASSWORD     -> role `txnet_ai_reader_user`,    DATABASE_AI_READER_URL
#                                (F-038-b: SELECT on named tables only, under
#                                tenant RLS — `20261002000300_ai_reader_role`)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_DIR="${ENV_DIR:-$ROOT_DIR}"
ENV_FILE="${ENV_FILE:-.env.dev}"
DB_EXEC="${DB_EXEC:-docker exec -i ${MAIN_DB_CONTAINER:-txnet-dev-postgres}}"
# main-db's own superuser, from its container's environment (compose/data.yml),
# so nothing on this side needs MAIN_DB_PASSWORD.
# shellcheck disable=SC2016 # expanded by the container's shell, not this one
PSQL_AS_OWNER='PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
# The SQL's psql variable <- the env variable that holds it.
ROLE_PASSWORDS=(app_pw=DB_APP_PASSWORD xt_pw=DB_CROSS_TENANT_PASSWORD ai_pw=DB_AI_READER_PASSWORD)

env_args=()
for file in .env "$ENV_FILE"; do
  [ ! -f "$ENV_DIR/$file" ] || env_args+=(--env-file "$ENV_DIR/$file")
done
declare -A env=()
while IFS= read -r line; do
  if [[ "$line" == *=* ]]; then env["${line%%=*}"]="${line#*=}"; fi
done < <(docker compose "${env_args[@]}" -f "$ROOT_DIR/dev-docker/docker-compose.main.yml" \
  config --environment 2>/dev/null)

# `\set name 'value'`: psql reads a backslash and a quote inside the quotes as `\\` and `''`.
preamble="" missing=()
for pair in "${ROLE_PASSWORDS[@]}"; do
  value="${env[${pair#*=}]:-}"
  [ -n "$value" ] || missing+=("${pair#*=}")
  quote="'"
  value="${value//\\/\\\\}"
  value="${value//$quote/$quote$quote}"
  preamble+="\\set ${pair%%=*} '$value'"$'\n'
done
[ ${#missing[@]} -eq 0 ] ||
  { echo "db-login-roles.sh: ${missing[*]} not set in $ENV_DIR/{.env,$ENV_FILE} — see the header of this file" >&2; exit 1; }

# shellcheck disable=SC2086 # DB_EXEC is a command and its arguments
{
  printf '%s' "$preamble"
  cat <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'txnet_app_user') THEN
    CREATE ROLE txnet_app_user LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'txnet_cross_tenant_user') THEN
    CREATE ROLE txnet_cross_tenant_user LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'txnet_ai_reader_user') THEN
    CREATE ROLE txnet_ai_reader_user LOGIN;
  END IF;
END
$$;

-- Re-asserted every run. These four attributes are the entire security value of
-- the split, and any one of them granted by hand later would undo it silently.
ALTER ROLE txnet_app_user          NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE txnet_cross_tenant_user NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE txnet_ai_reader_user    NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

ALTER ROLE txnet_app_user          PASSWORD :'app_pw';
ALTER ROLE txnet_cross_tenant_user PASSWORD :'xt_pw';
ALTER ROLE txnet_ai_reader_user    PASSWORD :'ai_pw';

-- Membership is what makes the policies apply: a policy `TO txnet_app` is
-- evaluated for anyone who inherits that role.
GRANT txnet_app          TO txnet_app_user;
GRANT txnet_cross_tenant TO txnet_cross_tenant_user;
GRANT txnet_ai_reader    TO txnet_ai_reader_user;

-- And the reverse is what keeps them apart: neither may reach the other's
-- policy, so the cross-tenant view is not one connection-string typo away.
REVOKE txnet_cross_tenant FROM txnet_app_user;
REVOKE txnet_app          FROM txnet_cross_tenant_user;
-- The ai reader holds SELECT on named tables and nothing else (F-038-b);
-- either group would hand it write access or every tenant's rows.
REVOKE txnet_app          FROM txnet_ai_reader_user;
REVOKE txnet_cross_tenant FROM txnet_ai_reader_user;
REVOKE txnet_ai_reader    FROM txnet_app_user, txnet_cross_tenant_user;
SQL
} | $DB_EXEC sh -c "$PSQL_AS_OWNER"

echo "txnet_app_user / txnet_cross_tenant_user / txnet_ai_reader_user ready on ${env[MAIN_DB_NAME]:-the database}."
echo "Set DATABASE_APP_URL, DATABASE_CROSS_TENANT_URL and DATABASE_AI_READER_URL to match (.env.example)."
