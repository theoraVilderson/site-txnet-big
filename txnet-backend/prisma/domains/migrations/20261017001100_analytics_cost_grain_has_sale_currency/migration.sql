-- F-1001-q: a sale's cost, and its refund's, is answered in the currency that
-- sale was made in. On the day a tenant changes currency — or a day a sale from
-- before it is refunded beside a new one — one cell then holds a cost for each
-- sale currency, so the grain gains `saleCurrencyCode`. Index only, no row is
-- touched: the wider key is created first, and the narrower one dropped is
-- looser for code still running, never stricter.
-- Rollback: recreate "analytics_cost_day_grain_key" on the old columns (fails
-- only if two rows already differ by sale currency alone — rebuild them first).

CREATE UNIQUE INDEX "analytics_cost_day_sale_grain_key" ON "billing"."analytics_cost_day"
  ("tenantId", "day", "kind", "panelId", "servedTenantId", "productId", "userId", "currencyCode", "saleCurrencyCode") NULLS NOT DISTINCT;
DROP INDEX "billing"."analytics_cost_day_grain_key"; -- contract: F-1001-q
