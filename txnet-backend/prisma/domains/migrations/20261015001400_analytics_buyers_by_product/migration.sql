-- F-1001-b: buyers per product and per panel. Distinct people do not sum, so
-- the catalog tab's `buyers` and tier A's people per cell (ADR-0104) need the
-- product and the panel on the user grain, as `analytics_sales_day` has them.
-- Additive: two nullable columns and the grain index widened to hold them.

ALTER TABLE "billing"."analytics_user_day" ADD COLUMN "productId" UUID, ADD COLUMN "panelId" UUID;

DROP INDEX "billing"."analytics_user_day_grain_key";
CREATE UNIQUE INDEX "analytics_user_day_grain_key" ON "billing"."analytics_user_day"("tenantId", "day", "currencyCode", "userId", "productId", "panelId") NULLS NOT DISTINCT;

-- Rows written before this carry no product: every tenant is rebuilt whole by
-- the next tick, and reads say `rebuilding` until it has been (the flag the
-- tick retries on, AnalyticsRollupService.refresh). The rollup is derived, so
-- nothing is lost.
UPDATE "billing"."analytics_rollup_state" SET "rebuildingSince" = now();
