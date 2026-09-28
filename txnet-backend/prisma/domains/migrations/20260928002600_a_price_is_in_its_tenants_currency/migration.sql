-- F-116-d (ADR-0098 part 2, amends F-0601) — a tenant prices in its operating
-- currency.
--
-- `price` and `metered_rate` record the currency their amount is in, as every
-- billing money row already does (F-116-b): backfilled `USD`, which is what
-- ADR-0019 made them, then NOT NULL with no default, so a writer must name it.
-- A reader takes only the rows in the tenant's operating currency; a platform
-- row in another currency is no price for that tenant (user, 2026-09-28).
--
-- A Grant locks its rate's currency with the rate (ADR-0073): a block is
-- bought, and a remainder credited, in the currency the rate was sold in.
-- One column is set exactly when the other is.
--
-- No FK to `currency.currency(code)`: those rows are seeded, not migrated
-- (F-116-a). A CHECK holds the shape.
--
-- Rollback: drop the three columns (their CHECKs go with them).

ALTER TABLE "catalog"."price"
    ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "price_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "catalog"."price" ALTER COLUMN "currencyCode" DROP DEFAULT;

ALTER TABLE "catalog"."metered_rate"
    ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "metered_rate_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "catalog"."metered_rate" ALTER COLUMN "currencyCode" DROP DEFAULT;

ALTER TABLE "entitlement"."grant" ADD COLUMN "meteredRateCurrencyCode" TEXT;
UPDATE "entitlement"."grant" SET "meteredRateCurrencyCode" = 'USD' WHERE "meteredRate" IS NOT NULL;
ALTER TABLE "entitlement"."grant"
    ADD CONSTRAINT "grant_metered_rate_currency_shape" CHECK ("meteredRateCurrencyCode" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "grant_metered_rate_currency_with_rate" CHECK (("meteredRate" IS NULL) = ("meteredRateCurrencyCode" IS NULL));
