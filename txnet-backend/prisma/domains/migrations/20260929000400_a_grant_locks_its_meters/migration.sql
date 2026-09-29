-- F-118-e (D-58, ADR-0105 decision 4): the rate card is locked on the Grant at
-- issue, per meter — ADR-0073 for every meter.
--
-- 1. `grant_meter`: one row per (Grant, meter), written by `GrantService.issue`
--    beside the quotas. The card's terms are copied (`rateCardId` is a record,
--    not a foreign key: a card goes with its variant, a sale does not), with
--    the counters `consumed`, `billed` (the rating cursor) and `funded`, all in
--    the meter's unit and never below zero.
-- 2. The terms never change (`grant_meter_terms_are_locked`); the counters do.
--    A row is never deleted: it is the price a sale was made at.
-- 3. Its Grant's tenant's (`same_tenant()`), strictly tenant-scoped RLS.
--
-- No backfill: a metered Grant issued before this keeps `meteredRate` as its
-- only record, which is what the byte engine reads until F-118-l moves it here.
--
-- Additive; rollback: DROP TABLE "entitlement"."grant_meter" and the function
-- `entitlement.grant_meter_terms_are_locked()`.

CREATE TABLE "entitlement"."grant_meter" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "meterKey" TEXT NOT NULL,
    "rateCardId" UUID,
    "unitSize" BIGINT NOT NULL,
    "unitPrice" DECIMAL(18,8) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "mode" "catalog"."RateCardMode" NOT NULL,
    "includedQuantity" BIGINT NOT NULL,
    "afterIncluded" "catalog"."RateCardAfterIncluded" NOT NULL,
    "consumed" BIGINT NOT NULL DEFAULT 0,
    "billed" BIGINT NOT NULL DEFAULT 0,
    "funded" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grant_meter_pkey" PRIMARY KEY ("id"),
    -- The card's own lines (catalog `rate_card_*`), held again on the copy.
    CONSTRAINT "grant_meter_unit_size_positive" CHECK ("unitSize" > 0),
    CONSTRAINT "grant_meter_included_not_negative" CHECK ("includedQuantity" >= 0),
    CONSTRAINT "grant_meter_metered_price_positive" CHECK ("unitPrice" > 0 OR "afterIncluded" = 'stop'),
    CONSTRAINT "grant_meter_unit_price_not_negative" CHECK ("unitPrice" >= 0),
    CONSTRAINT "grant_meter_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$'),
    CONSTRAINT "grant_meter_counters_not_negative" CHECK ("consumed" >= 0 AND "billed" >= 0 AND "funded" >= 0)
);

CREATE UNIQUE INDEX "grant_meter_grantId_meterKey_key" ON "entitlement"."grant_meter"("grantId", "meterKey");
CREATE INDEX "grant_meter_tenantId_idx" ON "entitlement"."grant_meter"("tenantId");

ALTER TABLE "entitlement"."grant_meter" ADD CONSTRAINT "grant_meter_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "entitlement"."grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "entitlement"."grant_meter" ADD CONSTRAINT "grant_meter_meterKey_fkey" FOREIGN KEY ("meterKey") REFERENCES "catalog"."meter"("key") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER grant_meter_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "grantId" ON "entitlement"."grant_meter"
  FOR EACH ROW EXECUTE FUNCTION entitlement.same_tenant();

CREATE FUNCTION entitlement.grant_meter_terms_are_locked() RETURNS trigger
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
     OR NEW."unitPrice" IS DISTINCT FROM OLD."unitPrice"
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."includedQuantity" IS DISTINCT FROM OLD."includedQuantity"
     OR NEW."afterIncluded" IS DISTINCT FROM OLD."afterIncluded"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'grant_meter_terms_are_locked: the terms a Grant was sold at never change; only its counters move'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER grant_meter_terms_are_locked BEFORE UPDATE OR DELETE ON "entitlement"."grant_meter"
  FOR EACH ROW EXECUTE FUNCTION entitlement.grant_meter_terms_are_locked();

ALTER TABLE entitlement.grant_meter ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.grant_meter FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement"."grant_meter" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "entitlement"."grant_meter"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "entitlement"."grant_meter"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
