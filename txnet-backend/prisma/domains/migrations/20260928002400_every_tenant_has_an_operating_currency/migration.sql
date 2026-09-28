-- F-116-a (ADR-0098 part 1) — every tenant has an operating currency.
--
-- `tenant.operatingCurrencyCode`: the currency the tenant keeps its books in,
-- the `platform_owner` row's being the platform's. Every existing tenant starts
-- at `USD`, so no stored amount changes meaning.
--
-- No FK to `currency.currency(code)`: those rows are seeded, not migrated, and
-- a fresh database has none. tenant-service admits only a currency with a
-- rate (contract.md "Operating currency"); the CHECK holds the shape.
--
-- Rollback: drop the column (and its CHECK with it).

ALTER TABLE "tenant"."tenant"
    ADD COLUMN "operatingCurrencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "tenant_operating_currency_code_shape" CHECK ("operatingCurrencyCode" ~ '^[A-Z]{3}$');
