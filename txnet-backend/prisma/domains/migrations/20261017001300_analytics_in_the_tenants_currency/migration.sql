-- F-1001-s, ADR-0152: analytics answers in the tenant's currency now, each
-- figure at its own day's rate. `currencyCode` is the currency a tenant's rows
-- were converted into; the rollup tick rebuilds a tenant whose operating
-- currency differs, as it does one whose zone moved (principle 5). Added null
-- on every row: each tenant is rebuilt once, in its currency now, by the first
-- tick after this deploys — which is what converts the histories already
-- written. Additive; no row is deleted.
-- Rollback: remove the column again (the rows stay as last converted).

ALTER TABLE "billing"."analytics_rollup_state" ADD COLUMN "currencyCode" TEXT;
ALTER TABLE "billing"."analytics_rollup_state" ADD CONSTRAINT "analytics_rollup_state_currency_code_shape" CHECK ("currencyCode" IS NULL OR "currencyCode" ~ '^[A-Z]{3}$');
