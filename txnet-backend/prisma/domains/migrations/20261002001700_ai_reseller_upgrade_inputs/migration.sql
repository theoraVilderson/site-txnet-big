-- F-038-o4 (ADR-0109 points 4, 8; ADR-0107 point 9): the upgrade the engine
-- suggests to a reseller names a package — the cheapest pricier one whose
-- quota holds the window's projected use. The reader already reads what each
-- package includes (`package_limit`, `package_product`, `20261002001600`);
-- this adds the packages themselves: name, prices, currency, active. The
-- platform's own price list — no tenant, no RLS, nothing secret.
--
-- Additive. Rollback: REVOKE SELECT ON tenant.tenant_feature_package FROM txnet_ai_reader.

GRANT SELECT ON tenant.tenant_feature_package TO txnet_ai_reader;
