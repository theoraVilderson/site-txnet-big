-- `analytics_sales_day.discounts` added `invoice.ruleDiscount` to `invoice.discount`,
-- which already includes it, so a rule discount was counted twice. The rollup now
-- reads `discount` alone; every tenant's history is rebuilt whole on the next tick.
UPDATE "billing"."analytics_rollup_state" SET "rebuildingSince" = now();
