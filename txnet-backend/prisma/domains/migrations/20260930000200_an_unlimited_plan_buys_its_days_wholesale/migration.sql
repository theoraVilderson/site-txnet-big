-- F-118-z (D-59 (c)): an unlimited package plan (`trafficUnlimited`) a
-- reseller sells on a group holding a platform panel has no bag to price, so
-- it buys its days instead: a flat wholesale amount per period, priced on the
-- reseller's package, charged at the sale and at every renewal.
--
-- 1. Meter `vpn.unlimited.time` (unit `seconds`), counted by billing-service,
--    which sells the days. Only a package rate names it
--    (`tenant_package_meter_rate`, `unitSize` = the period in seconds); a
--    rate card on it stays refused (`rate_card_not_served`).
-- 2. `grant_wholesale."meterKey"`: which rate the leg locked. `vpn.traffic`
--    (every row so far) counts bytes; `vpn.unlimited.time` counts seconds in
--    `billed`, and `consumed` stays 0 — metering-service advances only a
--    `vpn.traffic` leg. Locked with the other terms.
--
-- Additive; rollback: DROP COLUMN "meterKey", restore the previous
-- `grant_wholesale_terms_are_locked()`, DELETE the meter row.

INSERT INTO "catalog"."meter" ("id", "key", "unit", "reportedBy", "nameKey")
VALUES (gen_random_uuid(), 'vpn.unlimited.time', 'seconds', 'billing-service', 'catalog.meter.vpn.unlimited.time.name');

ALTER TABLE "entitlement"."grant_wholesale" ADD COLUMN "meterKey" TEXT NOT NULL DEFAULT 'vpn.traffic';
ALTER TABLE "entitlement"."grant_wholesale" ADD CONSTRAINT "grant_wholesale_meter_key_known"
  CHECK ("meterKey" IN ('vpn.traffic', 'vpn.unlimited.time'));

CREATE OR REPLACE FUNCTION entitlement.grant_wholesale_terms_are_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'grant_wholesale_terms_are_locked: a Grant''s wholesale leg is never deleted'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."grantId" IS DISTINCT FROM OLD."grantId"
     OR NEW."payerTenantId" IS DISTINCT FROM OLD."payerTenantId"
     OR NEW."rateId" IS DISTINCT FROM OLD."rateId"
     OR NEW."meterKey" IS DISTINCT FROM OLD."meterKey"
     OR NEW."unitSize" IS DISTINCT FROM OLD."unitSize"
     OR NEW."unitPrice" IS DISTINCT FROM OLD."unitPrice"
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'grant_wholesale_terms_are_locked: the rate a plan was sold at never changes; only its cursors move'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
