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
# Reads `.env` + `.env.dev` (or `.env.prod` with ENV_FILE=.env.prod) for
# MAIN_DB_* and for the two passwords below.
#
# Required in the environment (both are new):
#   DB_APP_PASSWORD           -> role `txnet_app_user`,          DATABASE_APP_URL
#   DB_CROSS_TENANT_PASSWORD  -> role `txnet_cross_tenant_user`, DATABASE_CROSS_TENANT_URL
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env.dev}"
set -a
# shellcheck disable=SC1091
[ -f .env ] && . ./.env
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "./$ENV_FILE"
set +a

: "${MAIN_DB_USERNAME:?MAIN_DB_USERNAME is not set}"
: "${MAIN_DB_NAME:?MAIN_DB_NAME is not set}"
: "${DB_APP_PASSWORD:?DB_APP_PASSWORD is not set — see the header of this file}"
: "${DB_CROSS_TENANT_PASSWORD:?DB_CROSS_TENANT_PASSWORD is not set — see the header of this file}"

CONTAINER="${MAIN_DB_CONTAINER:-txnet-dev-postgres}"

# `psql -v` + `:'name'` rather than string interpolation: a password with a
# quote in it must not be able to end the statement it is inside.
docker exec -i \
  -e PGPASSWORD="${MAIN_DB_PASSWORD:-}" \
  "$CONTAINER" \
  psql -v ON_ERROR_STOP=1 \
       -U "$MAIN_DB_USERNAME" -d "$MAIN_DB_NAME" \
       -v app_pw="$DB_APP_PASSWORD" \
       -v xt_pw="$DB_CROSS_TENANT_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'txnet_app_user') THEN
    CREATE ROLE txnet_app_user LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'txnet_cross_tenant_user') THEN
    CREATE ROLE txnet_cross_tenant_user LOGIN;
  END IF;
END
$$;

-- Re-asserted every run. These four attributes are the entire security value of
-- the split, and any one of them granted by hand later would undo it silently.
ALTER ROLE txnet_app_user          NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE txnet_cross_tenant_user NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

ALTER ROLE txnet_app_user          PASSWORD :'app_pw';
ALTER ROLE txnet_cross_tenant_user PASSWORD :'xt_pw';

-- Membership is what makes the policies apply: a policy `TO txnet_app` is
-- evaluated for anyone who inherits that role.
GRANT txnet_app          TO txnet_app_user;
GRANT txnet_cross_tenant TO txnet_cross_tenant_user;

-- And the reverse is what keeps them apart: neither may reach the other's
-- policy, so the cross-tenant view is not one connection-string typo away.
REVOKE txnet_cross_tenant FROM txnet_app_user;
REVOKE txnet_app          FROM txnet_cross_tenant_user;
SQL

echo "txnet_app_user / txnet_cross_tenant_user ready on ${MAIN_DB_NAME}."
echo "Set DATABASE_APP_URL and DATABASE_CROSS_TENANT_URL to match (.env.example)."
