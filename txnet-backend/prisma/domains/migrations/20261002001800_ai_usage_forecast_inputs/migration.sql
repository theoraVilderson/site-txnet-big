-- F-1525-a (ADR-0109 points 4, 6, 7): a reseller's billing wallet at its
-- wholesale rate — when it runs out, and the top-up that holds 30 days. A
-- forecast and a suggestion to a human; nothing here moves money (§24.3).
--
-- `tenant.tenant_billing_transaction` is keyed by wallet with no `tenantId`
-- and no RLS, so — as the views of `20261002000400_ai_profile_inputs` — the
-- reader gets a view scoped by the bound tenant's own wallet: the wholesale
-- spend only (`metered_usage_charge` debits, `metered_usage_refund` credits),
-- summed per UTC day for the last 35 days. No reference, no balance-after, no
-- other reason.
--
-- The wallet itself is strict-RLS per tenant: SELECT and an `ai_reader`
-- policy, so the reader sees the bound tenant's wallet only.
--
-- Additive. Rollback: DROP VIEW ai.reader_wholesale_spend; DROP POLICY
-- ai_reader ON tenant.tenant_billing_wallet; REVOKE the grants below.

CREATE VIEW ai.reader_wholesale_spend WITH (security_barrier) AS
  SELECT date_trunc('day', t."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS "day",
         COALESCE(SUM(t."amount") FILTER (WHERE t."reasonType" = 'metered_usage_charge' AND t."direction" = 'debit'), 0) AS "charged",
         COALESCE(SUM(t."amount") FILTER (WHERE t."reasonType" = 'metered_usage_refund' AND t."direction" = 'credit'), 0) AS "refunded",
         MIN(t."createdAt") FILTER (WHERE t."reasonType" = 'metered_usage_charge') AS "firstAt",
         t."currencyCode"
  FROM tenant.tenant_billing_transaction t
  JOIN tenant.tenant_billing_wallet w ON w."id" = t."walletId"
  WHERE w."tenantId" = public.current_tenant_id()
    AND t."reasonType" IN ('metered_usage_charge', 'metered_usage_refund')
    AND t."createdAt" > now() - interval '35 days'
  GROUP BY 1, t."currencyCode";

REVOKE ALL ON ai.reader_wholesale_spend FROM PUBLIC, txnet_app, txnet_cross_tenant;
GRANT SELECT ON ai.reader_wholesale_spend TO txnet_ai_reader;

GRANT SELECT ON tenant.tenant_billing_wallet TO txnet_ai_reader;
CREATE POLICY ai_reader ON tenant.tenant_billing_wallet
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());
