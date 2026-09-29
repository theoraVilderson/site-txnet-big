-- F-118-n2 (D-58, ADR-0105 decisions 4 and 10): a reseller's metered Grant
-- locks, on each `grant_meter`, the wholesale rate its package charges for that
-- platform meter — the price the platform bills the reseller for the usage.
--
-- 1. Five terms, all set or none (`grant_meter_wholesale_whole`): the payer
--    tenant, the `tenant_package_meter_rate` row copied (a record, not a
--    foreign key — a rate is history, a sale outlives its package), its
--    `unitSize`, `unitPrice Decimal(18,8)` and currency (the platform's).
--    Written by `GrantService.issue` for every meter a reseller sells,
--    whatever its panels (user, 2026-09-29); the platform's own Grants none.
-- 2. `wholesaleBilled`: the wholesale rating cursor over the same `consumed`,
--    never below zero, and zero on a meter with no wholesale leg.
-- 3. `grant_meter_terms_are_locked` locks the wholesale terms as it locks the
--    retail ones: never set later, never cleared, the price moving only with
--    its currency (the platform's currency change, `currency-change.ts`).
--
-- No backfill: a reseller Grant sold before this carries no wholesale leg and
-- is not billed one (F-118-n3 reads only a meter that has it).
--
-- Additive; rollback: drop the six columns and the two CHECKs, and restore the
-- function from 20260929000900_a_grants_rate_is_its_meters.

ALTER TABLE "entitlement"."grant_meter"
  ADD COLUMN "wholesalePayerTenantId" UUID,
  ADD COLUMN "wholesaleRateId" UUID,
  ADD COLUMN "wholesaleUnitSize" BIGINT,
  ADD COLUMN "wholesaleUnitPrice" DECIMAL(18,8),
  ADD COLUMN "wholesaleCurrencyCode" TEXT,
  ADD COLUMN "wholesaleBilled" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "entitlement"."grant_meter"
  ADD CONSTRAINT "grant_meter_wholesale_whole" CHECK (
    ("wholesalePayerTenantId" IS NULL AND "wholesaleRateId" IS NULL AND "wholesaleUnitSize" IS NULL
       AND "wholesaleUnitPrice" IS NULL AND "wholesaleCurrencyCode" IS NULL AND "wholesaleBilled" = 0)
    -- Each IS NOT NULL spelled out: a NULL comparison is not false, and a CHECK passes it.
    OR ("wholesalePayerTenantId" IS NOT NULL AND "wholesaleRateId" IS NOT NULL
       AND "wholesaleUnitSize" IS NOT NULL AND "wholesaleUnitPrice" IS NOT NULL AND "wholesaleCurrencyCode" IS NOT NULL
       AND "wholesaleUnitSize" > 0 AND "wholesaleUnitPrice" > 0
       AND "wholesaleCurrencyCode" ~ '^[A-Z]{3}$')),
  ADD CONSTRAINT "grant_meter_wholesale_billed_not_negative" CHECK ("wholesaleBilled" >= 0);

CREATE OR REPLACE FUNCTION entitlement.grant_meter_terms_are_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'grant_meter_terms_are_locked: a Grant''s meter is never deleted'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."grantId" IS DISTINCT FROM OLD."grantId"
     OR NEW."meterKey" IS DISTINCT FROM OLD."meterKey"
     OR NEW."rateCardId" IS DISTINCT FROM OLD."rateCardId"
     OR NEW."unitSize" IS DISTINCT FROM OLD."unitSize"
     -- A currency change converts the price (user, 2026-09-29); a price moving on its own is a reprice.
     OR (NEW."unitPrice" IS DISTINCT FROM OLD."unitPrice" AND NEW."currencyCode" = OLD."currencyCode")
     OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."includedQuantity" IS DISTINCT FROM OLD."includedQuantity"
     OR NEW."afterIncluded" IS DISTINCT FROM OLD."afterIncluded"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     -- The wholesale leg (F-118-n2): locked at issue, its price moving only with the platform's currency.
     OR NEW."wholesalePayerTenantId" IS DISTINCT FROM OLD."wholesalePayerTenantId"
     OR NEW."wholesaleRateId" IS DISTINCT FROM OLD."wholesaleRateId"
     OR NEW."wholesaleUnitSize" IS DISTINCT FROM OLD."wholesaleUnitSize"
     OR (NEW."wholesaleCurrencyCode" IS NULL) <> (OLD."wholesaleCurrencyCode" IS NULL)
     OR (NEW."wholesaleUnitPrice" IS DISTINCT FROM OLD."wholesaleUnitPrice"
         AND NEW."wholesaleCurrencyCode" IS NOT DISTINCT FROM OLD."wholesaleCurrencyCode") THEN
    RAISE EXCEPTION 'grant_meter_terms_are_locked: the terms a Grant was sold at never change; only its counters move, and its prices only with their currency'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
