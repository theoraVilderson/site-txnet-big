-- F-1001-l (ADR-0149): every cost row also in the tenant's operating
-- currency, converted at its own day's rate — the figure margin subtracts.
-- Additive: two columns; `saleCost` null = no rate converted it. A
-- reseller's wholesale rows now name their panel and user too, so every
-- tenant is rebuilt whole by the next tick (as `20261016000400`).

ALTER TABLE "billing"."analytics_cost_day" ADD COLUMN "saleCurrencyCode" TEXT, ADD COLUMN "saleCost" DECIMAL(18,6);
UPDATE "billing"."analytics_cost_day" SET "saleCurrencyCode" = "currencyCode";
ALTER TABLE "billing"."analytics_cost_day" ALTER COLUMN "saleCurrencyCode" SET NOT NULL;

UPDATE "billing"."analytics_rollup_state" SET "rebuildingSince" = now();
