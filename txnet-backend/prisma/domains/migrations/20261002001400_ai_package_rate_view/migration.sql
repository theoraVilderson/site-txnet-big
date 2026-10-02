-- F-1528 (ADR-0109 point 8): the reseller's margin report prices each plan
-- at its package's rate in force now. `tenant.tenant_package_meter_rate` is
-- keyed by package with no `tenantId`, so — as the views of
-- `20261002000400_ai_profile_inputs` — the reader gets a view that scopes it
-- by the bound tenant's own subscription: its package's active rates in the
-- package's currency (a row in another money predates a currency change), and
-- no other package's price list. Which row is in force is the reader's.
--
-- Additive. Rollback: DROP VIEW ai.reader_package_rate.

CREATE VIEW ai.reader_package_rate WITH (security_barrier) AS
  SELECT r."meterKey", r."unitSize", r."unitPrice", r."currencyCode", r."effectiveFrom", r."createdAt"
  FROM tenant.tenant_package_meter_rate r
  JOIN tenant.tenant_subscription s ON s."packageId" = r."packageId"
  JOIN tenant.tenant_feature_package p ON p."id" = r."packageId"
  WHERE s."tenantId" = public.current_tenant_id()
    AND r."isActive"
    AND r."currencyCode" = p."currencyCode";

REVOKE ALL ON ai.reader_package_rate FROM PUBLIC, txnet_app, txnet_cross_tenant;
GRANT SELECT ON ai.reader_package_rate TO txnet_ai_reader;
