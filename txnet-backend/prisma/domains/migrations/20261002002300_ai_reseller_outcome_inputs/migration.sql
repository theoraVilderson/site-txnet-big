-- F-038-o5 (ADR-0109 point 13): a reseller's suggestion converts on what it
-- named — an upgrade on its upgrade charge, a top-up on a billing-wallet top-up.
-- `tenant.tenant_billing_transaction` has no RLS (it hangs off the wallet), so,
-- as `ai.reader_wholesale_spend`, the reader gets a view scoped by the bound
-- tenant's own wallet: those two reasons only, 60 days, no reference, no
-- balance.
--
-- Additive. Rollback: DROP VIEW ai.reader_billing_event.

CREATE VIEW ai.reader_billing_event WITH (security_barrier) AS
  SELECT t."id",
         CASE WHEN t."reasonType" = 'subscription_upgrade_charge' THEN 'upgrade' ELSE 'top_up' END AS "kind",
         t."amount", t."currencyCode", t."createdAt"
  FROM tenant.tenant_billing_transaction t
  JOIN tenant.tenant_billing_wallet w ON w."id" = t."walletId"
  WHERE w."tenantId" = public.current_tenant_id()
    AND (t."reasonType"::text, t."direction"::text) IN (('subscription_upgrade_charge', 'debit'), ('topup_payment', 'credit'))
    AND t."createdAt" > now() - interval '60 days';

REVOKE ALL ON ai.reader_billing_event FROM PUBLIC, txnet_app, txnet_cross_tenant;
GRANT SELECT ON ai.reader_billing_event TO txnet_ai_reader;
