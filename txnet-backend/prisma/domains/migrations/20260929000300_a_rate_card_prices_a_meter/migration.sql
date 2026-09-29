-- F-118-d (D-58, ADR-0105 decision 3): a rate card prices a meter on a variant.
--
-- `metered_rate` priced one thing — VPN bytes per 2^30 — in one mode, paid
-- before it is served. A rate card names the meter it prices, the unit size a
-- price buys, the mode the seller picked (prepaid, or postpaid: held and
-- captured on use), what the plan includes and whether the meter stops or
-- charges past it. One row sells per-GB VPN and a hybrid plan alike.
--
-- 1. Shaped like `price` and `metered_rate`, down to their triggers: a card is
--    history, and a child carries its variant's tenant. A card that could be
--    edited in place would reprice usage already sold (ADR-0073).
-- 2. `Decimal(18, 8)`, the precision `metered_rate` has. Amounts derived from
--    it are rounded to whole minor units before the ledger sees them (C-02).
-- 3. The meter by its key, not its id: Grants and code (`METER_KEYS`) hold the
--    key, and `meter_is_immutable` keeps it. RESTRICT both ways.
-- 4. A tenant writes cards on its own variants only — RLS writes its own
--    tenant, `same_tenant_as_parent` that it is the variant's. A reseller
--    cannot price a platform variant (ADR-0105 decision 10).
--
-- Every `metered_rate` row becomes a `vpn.traffic` prepaid card per 2^30
-- bytes, nothing included, then metered: exactly what it meant. The table is
-- kept, read by nothing and written by no service role, until F-118-l drops it.
-- Rollback: drop `rate_card`, its types, triggers and function; re-grant
-- INSERT, UPDATE on `metered_rate`.

CREATE TYPE "catalog"."RateCardMode" AS ENUM ('prepaid', 'postpaid');
CREATE TYPE "catalog"."RateCardAfterIncluded" AS ENUM ('stop', 'metered');

CREATE TABLE "catalog"."rate_card" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "variantId" UUID NOT NULL,
    "meterKey" TEXT NOT NULL,
    "unitSize" BIGINT NOT NULL,
    "unitPrice" DECIMAL(18,8) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "mode" "catalog"."RateCardMode" NOT NULL,
    "includedQuantity" BIGINT NOT NULL DEFAULT 0,
    "afterIncluded" "catalog"."RateCardAfterIncluded" NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_card_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rate_card_unit_size_positive" CHECK ("unitSize" > 0),
    CONSTRAINT "rate_card_included_not_negative" CHECK ("includedQuantity" >= 0),
    -- A unit charged at zero is one nobody can buy (F-027-al): the purchaser
    -- has nothing to debit and the cursor nothing to advance against. Free
    -- usage is an included quantity that stops. Below zero pays the user.
    CONSTRAINT "rate_card_metered_price_positive" CHECK ("unitPrice" > 0 OR "afterIncluded" = 'stop'),
    CONSTRAINT "rate_card_unit_price_not_negative" CHECK ("unitPrice" >= 0),
    -- Nothing included and nothing past it is a meter that serves nothing.
    CONSTRAINT "rate_card_stop_includes_some" CHECK ("afterIncluded" = 'metered' OR "includedQuantity" > 0),
    CONSTRAINT "rate_card_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$')
);

-- Resolution at sale asks `price`'s question, per meter: the newest active row
-- at or before the instant.
CREATE INDEX "rate_card_variantId_meterKey_effectiveFrom_idx" ON "catalog"."rate_card"("variantId", "meterKey", "effectiveFrom" DESC);
CREATE INDEX "rate_card_tenantId_idx" ON "catalog"."rate_card"("tenantId");

ALTER TABLE "catalog"."rate_card" ADD CONSTRAINT "rate_card_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "catalog"."product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog"."rate_card" ADD CONSTRAINT "rate_card_meterKey_fkey"
  FOREIGN KEY ("meterKey") REFERENCES "catalog"."meter"("key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A child carries its parent's tenant (invariant 3): the ELSE branch reads
-- `NEW."variantId"`, as for `price` and `metered_rate`.
CREATE TRIGGER rate_card_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "variantId" ON "catalog"."rate_card"
  FOR EACH ROW EXECUTE FUNCTION catalog.same_tenant_as_parent();

-- A card is history (invariant 2c): only `isActive` changes, and it is deleted
-- only by its variant's cascade — the variant's row is gone by then.
CREATE FUNCTION catalog.rate_card_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "catalog"."product_variant" WHERE "id" = OLD."variantId") THEN
      RAISE EXCEPTION 'rate_card_is_history: a rate card is never deleted; switch it off or write a new one'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW."variantId", NEW."tenantId", NEW."meterKey", NEW."unitSize", NEW."unitPrice", NEW."currencyCode", NEW."mode",
      NEW."includedQuantity", NEW."afterIncluded", NEW."effectiveFrom", NEW."createdByAdminId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."variantId", OLD."tenantId", OLD."meterKey", OLD."unitSize", OLD."unitPrice", OLD."currencyCode", OLD."mode",
      OLD."includedQuantity", OLD."afterIncluded", OLD."effectiveFrom", OLD."createdByAdminId", OLD."createdAt") THEN
    RAISE EXCEPTION 'rate_card_is_history: only isActive changes on a rate card; write a new one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER rate_card_is_history BEFORE UPDATE OR DELETE ON "catalog"."rate_card"
  FOR EACH ROW EXECUTE FUNCTION catalog.rate_card_is_history();

-- `metered_rate` rows become `vpn.traffic` prepaid cards, ids and history kept.
INSERT INTO "catalog"."rate_card" ("id", "tenantId", "variantId", "meterKey", "unitSize", "unitPrice", "currencyCode", "mode",
                                   "includedQuantity", "afterIncluded", "effectiveFrom", "isActive", "createdByAdminId", "createdAt")
SELECT m."id", m."tenantId", m."variantId", 'vpn.traffic', 1073741824, m."rate", m."currencyCode", 'prepaid', 0, 'metered',
       m."effectiveFrom", m."isActive", m."createdByAdminId", m."createdAt"
  FROM "catalog"."metered_rate" m;

-- Read by nothing from here on: a row written to it would be a price nobody
-- charges. DELETE stays, for its variant's cascade.
REVOKE INSERT, UPDATE ON "catalog"."metered_rate" FROM txnet_app, txnet_cross_tenant;

-- Row-Level Security: shared-read, as `price` and `metered_rate`.
ALTER TABLE catalog.rate_card ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."rate_card" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "catalog"."rate_card" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "catalog"."rate_card"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "catalog"."rate_card"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
