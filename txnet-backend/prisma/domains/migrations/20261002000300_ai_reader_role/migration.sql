-- F-038-b (ADR-0109 point 6, user 2026-10-02): the role `ai-service` reads
-- other units' tables through.
--
-- Three properties, each asserted by `ai-service/src/app/reader/reader-role.spec.ts`:
--
--   * SELECT only. No write grant, and no membership of `txnet_app` — that
--     group may write every table, and inheriting it would hand the engine the
--     ledger. `ai-service` writes `ai.*` and `engagement.attention_budget` on
--     the app pool, as every service writes its own tables.
--   * Named tables only, listed in `reader-tables.ts`. No `ON ALL TABLES`, no
--     default privileges: a table created next month is not readable until
--     someone names it. Nothing under `network` (point 6). `identity.user` is
--     a column grant — no name, contact or secret leaves for the engine
--     (point 14).
--   * One tenant's rows. A policy `TO txnet_ai_reader` per table, the same
--     tenant clause as the table's own app policy (strict, or shared-read for
--     the platform's catalog and coupons). Without a policy for this role, RLS
--     would show it nothing — which is safe, but the clause is what makes it
--     useful and nothing more.
--
-- The login role `txnet_ai_reader_user` carries a password and is made by
-- `scripts/db-login-roles.sh`, as the other two.
--
-- Additive. Rollback: DROP POLICY ai_reader on each table below, REVOKE the
-- grants, DROP ROLE txnet_ai_reader.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'txnet_ai_reader') THEN
    CREATE ROLE txnet_ai_reader NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
ALTER ROLE txnet_ai_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public, identity, entitlement, billing, catalog, tenant TO txnet_ai_reader;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO txnet_ai_reader;

GRANT SELECT ("id", "tenantId", "status", "languagePreference", "noticeMessenger", "timezone", "timezoneSource", "referredByUserId", "createdAt", "deletedAt") ON identity.user TO txnet_ai_reader;
CREATE POLICY ai_reader ON identity.user
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON entitlement.grant TO txnet_ai_reader;
CREATE POLICY ai_reader ON entitlement.grant
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON entitlement.grant_meter TO txnet_ai_reader;
CREATE POLICY ai_reader ON entitlement.grant_meter
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON entitlement.grant_renewal TO txnet_ai_reader;
CREATE POLICY ai_reader ON entitlement.grant_renewal
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON billing.wallet_transaction TO txnet_ai_reader;
CREATE POLICY ai_reader ON billing.wallet_transaction
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON billing.payment_transaction TO txnet_ai_reader;
CREATE POLICY ai_reader ON billing.payment_transaction
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON billing.invoice TO txnet_ai_reader;
CREATE POLICY ai_reader ON billing.invoice
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON billing.coupon TO txnet_ai_reader;
CREATE POLICY ai_reader ON billing.coupon
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id());

GRANT SELECT ON catalog.product TO txnet_ai_reader;
CREATE POLICY ai_reader ON catalog.product
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id());

GRANT SELECT ON catalog.product_variant TO txnet_ai_reader;
CREATE POLICY ai_reader ON catalog.product_variant
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id());

GRANT SELECT ON catalog.price TO txnet_ai_reader;
CREATE POLICY ai_reader ON catalog.price
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id());

GRANT SELECT ON tenant.tenant_subscription TO txnet_ai_reader;
CREATE POLICY ai_reader ON tenant.tenant_subscription
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON tenant.tenant_feature_entitlement TO txnet_ai_reader;
CREATE POLICY ai_reader ON tenant.tenant_feature_entitlement
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON tenant.reseller_limit TO txnet_ai_reader;
CREATE POLICY ai_reader ON tenant.reseller_limit
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON tenant.reseller_quota_usage TO txnet_ai_reader;
CREATE POLICY ai_reader ON tenant.reseller_quota_usage
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

