-- F-116-j (ADR-0098 part 9, ADR-0101): a tenant pins a manual rate that prices
-- only inside its own books. A tenant's pin is a `manual_admin` row with its
-- `tenantId`; the platform's pin and every discovered rate have none.
-- Additive: every existing row keeps `tenantId` null, which the CHECK allows.

ALTER TABLE "currency"."currency_exchange_rate" ADD COLUMN "tenantId" UUID;

ALTER TABLE "currency"."currency_exchange_rate"
    ADD CONSTRAINT "currency_exchange_rate_tenant_pin_only"
    CHECK ("tenantId" IS NULL OR "source" = 'manual_admin');

CREATE INDEX "currency_exchange_rate_currencyId_tenantId_effectiveAt_idx"
    ON "currency"."currency_exchange_rate"("currencyId", "tenantId", "effectiveAt" DESC);
