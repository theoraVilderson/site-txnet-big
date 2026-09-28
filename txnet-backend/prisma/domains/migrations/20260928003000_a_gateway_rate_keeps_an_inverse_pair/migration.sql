-- A gateway's rate columns are charge units per unit of the tenant's
-- currency, so a currency change divides them (F-116-f). Between currencies of
-- very different size the result is tiny: a static rate of 1 USD per USD
-- becomes ~0.0000017 USD per IRR, and DECIMAL(18,8) kept 2-3 significant
-- digits of it. Widened to DECIMAL(30,18), as `exchangeRateSnapshot` and
-- `currency_change.rate` are. Only the scale grows (12 whole digits, as before
-- 10): no stored value changes, and `roundingStep` stays in charge units.

ALTER TABLE "tenant"."tenant_gateway_config"
  ALTER COLUMN "staticRate" SET DATA TYPE DECIMAL(30,18),
  ALTER COLUMN "fixedAmountModifier" SET DATA TYPE DECIMAL(30,18),
  ALTER COLUMN "minRate" SET DATA TYPE DECIMAL(30,18),
  ALTER COLUMN "maxRate" SET DATA TYPE DECIMAL(30,18);

ALTER TABLE "billing"."payment_gateway"
  ALTER COLUMN "staticRate" SET DATA TYPE DECIMAL(30,18),
  ALTER COLUMN "fixedAmountModifier" SET DATA TYPE DECIMAL(30,18),
  ALTER COLUMN "minRate" SET DATA TYPE DECIMAL(30,18),
  ALTER COLUMN "maxRate" SET DATA TYPE DECIMAL(30,18);
