-- F-118-l (D-58, ADR-0105 decisions 0 and 12, stage 5): a metered Grant's own
-- columns retire into its `vpn.traffic` `grant_meter`. One money engine.
--
-- 1. Backfill. A metered Grant issued before F-118-e has only `meteredRate`:
--    it gets the meter issue would have written — per 2^30 bytes, nothing
--    included, then metered, prepaid (every `metered_rate` row was a prepaid
--    card) — with `billed` = its `billedBytes` and `funded` = the same (what
--    its blocks bought). A Grant that already has one gets its `billedBytes`
--    as `billed`, and on a prepaid meter `funded` too: until now the block
--    purchaser moved the Grant's cursor only. A postpaid meter already
--    carries both (F-118-k mirrored them onto the Grant, not the other way).
-- 2. `grant.meteredRate`, `meteredRateCurrencyCode` and `billedBytes` are
--    dropped, with the CHECKs on them. `grant_byte_counters_not_negative`
--    named `billedBytes` too, so it goes with it and is written again over
--    the two counters that stay. `purchasedBytes` stays the planner's bag for
--    every Grant, so a package plan (decision 0) moves nothing here.
-- 3. A `vpn.traffic` meter is the shape the byte engine serves
--    (`vpnTrafficRateAt`): 2^30 bytes a unit, nothing included, then metered.
--    Held in the column, so no reader has to check it.
-- 4. The terms stay locked, with one exception (user, 2026-09-29): a tenant's
--    currency change converts an open Grant's meter, as it converted
--    `meteredRate` — `unitPrice` may change only in the same write that
--    changes `currencyCode`. The same price in another money, never a reprice.
-- 5. `catalog.metered_rate`, read by nothing since F-118-d, is dropped with
--    its history trigger.
--
-- Rollback: re-add the three columns and fill them from the `vpn.traffic`
-- meter (`unitPrice`, `currencyCode`, `billed`); restore the trigger from
-- 20260929000400; `metered_rate` is not restored (its rows are rate cards).

-- 1. -------------------------------------------------------------------------
INSERT INTO "entitlement"."grant_meter"
    (id, "tenantId", "grantId", "meterKey", "rateCardId", "unitSize", "unitPrice", "currencyCode", mode,
     "includedQuantity", "afterIncluded", consumed, billed, funded, "createdAt", "updatedAt")
SELECT gen_random_uuid(), g."tenantId", g.id, 'vpn.traffic', NULL, 1073741824, g."meteredRate", g."meteredRateCurrencyCode",
       'prepaid', 0, 'metered', 0, g."billedBytes", g."billedBytes", g."createdAt", now()
  FROM "entitlement"."grant" g
 WHERE g."meteredRate" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "entitlement"."grant_meter" m WHERE m."grantId" = g.id AND m."meterKey" = 'vpn.traffic');

UPDATE "entitlement"."grant_meter" m
   SET "billed" = g."billedBytes", "funded" = g."billedBytes"
  FROM "entitlement"."grant" g
 WHERE m."grantId" = g.id AND m."meterKey" = 'vpn.traffic' AND m.mode = 'prepaid';

-- 2. -------------------------------------------------------------------------
ALTER TABLE "entitlement"."grant"
    DROP COLUMN "meteredRate",
    DROP COLUMN "meteredRateCurrencyCode",
    DROP COLUMN "billedBytes";

ALTER TABLE "entitlement"."grant"
    -- A counter going backward is a reset, never negative usage (ADR-0074).
    ADD CONSTRAINT "grant_byte_counters_not_negative" CHECK ("consumedBytes" >= 0 AND "purchasedBytes" >= 0);

-- 3. -------------------------------------------------------------------------
ALTER TABLE "entitlement"."grant_meter"
    ADD CONSTRAINT "grant_meter_vpn_traffic_is_per_gib" CHECK (
        "meterKey" <> 'vpn.traffic' OR ("unitSize" = 1073741824 AND "includedQuantity" = 0 AND "afterIncluded" = 'metered'));

-- 4. -------------------------------------------------------------------------
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
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'grant_meter_terms_are_locked: the terms a Grant was sold at never change; only its counters move, and its price only with its currency'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- 5. -------------------------------------------------------------------------
DROP TABLE "catalog"."metered_rate";
DROP FUNCTION catalog.metered_rate_is_history();
