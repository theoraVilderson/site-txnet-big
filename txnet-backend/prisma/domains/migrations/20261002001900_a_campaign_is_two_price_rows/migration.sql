-- F-503-a (D-45, F-503's rule: a campaign never overwrites a price). A
-- variant's time-boxed price is a `price_campaign` row and two new `price`
-- rows written with it: the campaign's amount from `startsAt`, and the price in
-- effect before it back from `endsAt`. Cancelling it before it starts switches
-- both rows off (`isActive`, the one change `price_is_history` allows). The
-- server's clock decides what is in effect, as for every price.
--
-- `price.campaignId` names the campaign a row belongs to; `campaignEndsAt`,
-- set on the campaign's own row alone, is what an offer counts down to. Both
-- are fixed at insert: `price_is_history` now holds them too.
--
-- Additive. Rollback: drop the two columns and the table; restore the
-- function from 20260925000300.

CREATE TABLE "catalog"."price_campaign" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID,
  "variantId"        UUID NOT NULL,
  "amount"           DECIMAL(18,2) NOT NULL,
  "currencyCode"     TEXT NOT NULL,
  "startsAt"         TIMESTAMP(3) NOT NULL,
  "endsAt"           TIMESTAMP(3) NOT NULL,
  "cancelledAt"      TIMESTAMP(3),
  "createdByAdminId" UUID,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "price_campaign_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "price_campaign_ends_after_it_starts" CHECK ("endsAt" > "startsAt"),
  CONSTRAINT "price_campaign_amount_not_negative" CHECK ("amount" >= 0),
  CONSTRAINT "price_campaign_currency_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$')
);
CREATE INDEX "price_campaign_variantId_endsAt_idx" ON "catalog"."price_campaign"("variantId", "endsAt");
CREATE INDEX "price_campaign_tenantId_idx" ON "catalog"."price_campaign"("tenantId");
ALTER TABLE "catalog"."price_campaign" ADD CONSTRAINT "price_campaign_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "catalog"."product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Its variant's tenant, as a price (`catalog_tenant_mismatch`).
CREATE TRIGGER price_campaign_same_tenant_as_parent BEFORE INSERT OR UPDATE ON "catalog"."price_campaign"
  FOR EACH ROW EXECUTE FUNCTION catalog.same_tenant_as_parent();

ALTER TABLE "catalog"."price" ADD COLUMN "campaignId" UUID, ADD COLUMN "campaignEndsAt" TIMESTAMP(3);
ALTER TABLE "catalog"."price" ADD CONSTRAINT "price_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "catalog"."price_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog"."price" ADD CONSTRAINT "price_campaign_end_only_with_its_campaign"
  CHECK ("campaignEndsAt" IS NULL OR "campaignId" IS NOT NULL);
CREATE INDEX "price_campaignId_idx" ON "catalog"."price"("campaignId");

CREATE OR REPLACE FUNCTION catalog.price_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "catalog"."product_variant" WHERE "id" = OLD."variantId") THEN
      RAISE EXCEPTION 'price_is_history: a price row is never deleted; switch it off or write a new one'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW."variantId", NEW."tenantId", NEW."amount", NEW."effectiveFrom", NEW."createdByAdminId", NEW."createdAt", NEW."campaignId", NEW."campaignEndsAt")
     IS DISTINCT FROM
     (OLD."variantId", OLD."tenantId", OLD."amount", OLD."effectiveFrom", OLD."createdByAdminId", OLD."createdAt", OLD."campaignId", OLD."campaignEndsAt") THEN
    RAISE EXCEPTION 'price_is_history: only isActive changes on a price row; write a new one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- Row-Level Security: shared-read, as `price`.
ALTER TABLE "catalog"."price_campaign" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."price_campaign" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "catalog"."price_campaign" TO txnet_app, txnet_cross_tenant;
CREATE POLICY tenant_isolation ON "catalog"."price_campaign"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "catalog"."price_campaign"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
