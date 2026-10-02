-- F-038-o1 (ADR-0109 points 4, 6, 7): the platform's hourly run predicts each
-- reseller's quota run-out and churn risk, the reseller being the platform's
-- customer (subject `tenant`, rows in the platform's tenant).
--
-- Two reads, both through the reader (invariant 7):
--
-- 1. Who the resellers are — `ai.reader_reseller`. `tenant.tenant` has no RLS
--    and `tenant_subscription` / `tenant_billing_wallet` are strict-RLS per
--    reseller, so the list is a view that answers **only when the bound tenant
--    is the platform owner** (user, 2026-10-02): a reseller bound here reads
--    nothing, never another reseller. Named columns: no slug, domain or reason.
--
-- 2. Each reseller's quota statement — read in **that reseller's own scope**
--    by shared-core's own read-only functions (`quotaTermsOf`,
--    `productQuotaStatementsOf`, `meterStatementOf`), so the engine applies the
--    terms the quota engine applies and never re-derives them. The grants below
--    are the tables those functions SELECT; the strict-RLS ones show the bound
--    reseller's rows only. `tenant.tenant` by named columns: its type, never
--    its owner, slug or status.
--
-- Additive. Rollback: DROP VIEW ai.reader_reseller; DROP POLICY ai_reader on
-- the two reseller tables; REVOKE the grants below.

CREATE VIEW ai.reader_reseller WITH (security_barrier) AS
  SELECT t."id" AS "tenantId", t."ownerUserId", t."status", t."billingModel",
         s."packageId", s."currentPeriodEnd", s."renewalWarnedAt", s."graceUntil", s."nextPackageId",
         p."monthlyPrice", p."yearlyPrice", p."currencyCode" AS "priceCurrency",
         w."cachedBalance" AS "walletBalance", w."currencyCode" AS "walletCurrency"
  FROM tenant.tenant t
  LEFT JOIN tenant.tenant_subscription s ON s."tenantId" = t."id"
  LEFT JOIN tenant.tenant_feature_package p ON p."id" = s."packageId"
  LEFT JOIN tenant.tenant_billing_wallet w ON w."tenantId" = t."id"
  WHERE t."tenantType" = 'reseller'
    AND t."deletedAt" IS NULL
    AND EXISTS (
      SELECT 1 FROM tenant.tenant me
      WHERE me."id" = public.current_tenant_id() AND me."tenantType" = 'platform_owner'
    );

REVOKE ALL ON ai.reader_reseller FROM PUBLIC, txnet_app, txnet_cross_tenant;
GRANT SELECT ON ai.reader_reseller TO txnet_ai_reader;

GRANT SELECT ("id", "tenantType", "deletedAt") ON tenant.tenant TO txnet_ai_reader;

-- The platform's own terms: one row per key or package, no tenant, no RLS.
GRANT SELECT ON tenant.tenant_subscription_setting TO txnet_ai_reader;
GRANT SELECT ON tenant.package_limit TO txnet_ai_reader;
GRANT SELECT ON tenant.reseller_limit_setting TO txnet_ai_reader;
GRANT SELECT ON tenant.quota_overage_setting TO txnet_ai_reader;
GRANT SELECT ON tenant.package_quota_overage TO txnet_ai_reader;
GRANT SELECT ON tenant.package_product TO txnet_ai_reader;

-- One reseller's own terms: strict RLS, so the reader sees the bound reseller's rows only.
GRANT SELECT ON tenant.reseller_quota_overage TO txnet_ai_reader;
CREATE POLICY ai_reader ON tenant.reseller_quota_overage
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON tenant.reseller_quota_terms_lock TO txnet_ai_reader;
CREATE POLICY ai_reader ON tenant.reseller_quota_terms_lock
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());
