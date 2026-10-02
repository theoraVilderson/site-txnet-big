-- F-505-a (D-45): a tenant's seasons on the Jalali calendar — Nowruz, Yalda
-- (`dated`: a Jalali month and day), Thursday night (`weekly`: a weekday) —
-- from `startMinute` past midnight on the tenant's clock for
-- `durationMinutes`. Each coming occurrence is written as a campaign price
-- (F-503-a) for every variant the season prices: never an overwrite.
-- `price_campaign.seasonId` names the season, and a partial unique index
-- writes each (season, variant, start) once, so the writer is safe to run
-- twice (ADR-0027).
--
-- Additive. Rollback: drop the index and column on price_campaign, then
-- season_price, season and the enum.

CREATE TYPE "catalog"."SeasonKind" AS ENUM ('dated', 'weekly');

CREATE TABLE "catalog"."season" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID,
  "name"             TEXT NOT NULL,
  "kind"             "catalog"."SeasonKind" NOT NULL,
  "month"            INTEGER,
  "day"              INTEGER,
  "weekday"          INTEGER,
  "startMinute"      INTEGER NOT NULL,
  "durationMinutes"  INTEGER NOT NULL,
  "isActive"         BOOLEAN NOT NULL DEFAULT true,
  "createdByAdminId" UUID,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "season_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "season_name_present" CHECK (length(btrim("name")) BETWEEN 1 AND 80),
  CONSTRAINT "season_when_by_kind" CHECK (
    ("kind" = 'dated' AND "month" BETWEEN 1 AND 12 AND "day" BETWEEN 1 AND 31 AND "weekday" IS NULL)
    OR ("kind" = 'weekly' AND "weekday" BETWEEN 0 AND 6 AND "month" IS NULL AND "day" IS NULL)
  ),
  CONSTRAINT "season_start_in_a_day" CHECK ("startMinute" BETWEEN 0 AND 1439),
  CONSTRAINT "season_lasts_up_to_a_month" CHECK ("durationMinutes" BETWEEN 1 AND 44640)
);
CREATE INDEX "season_tenantId_idx" ON "catalog"."season"("tenantId");

CREATE TABLE "catalog"."season_price" (
  "seasonId"         UUID NOT NULL,
  "variantId"        UUID NOT NULL,
  "tenantId"         UUID,
  "amount"           DECIMAL(18,2) NOT NULL,
  "updatedByAdminId" UUID,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "season_price_pkey" PRIMARY KEY ("seasonId", "variantId"),
  CONSTRAINT "season_price_amount_not_negative" CHECK ("amount" >= 0)
);
CREATE INDEX "season_price_variantId_idx" ON "catalog"."season_price"("variantId");
ALTER TABLE "catalog"."season_price" ADD CONSTRAINT "season_price_seasonId_fkey"
  FOREIGN KEY ("seasonId") REFERENCES "catalog"."season"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog"."season_price" ADD CONSTRAINT "season_price_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "catalog"."product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- The variant's tenant, as a price; the season's is held by the service (one tenant's season prices its own variants).
CREATE TRIGGER season_price_same_tenant_as_parent BEFORE INSERT OR UPDATE ON "catalog"."season_price"
  FOR EACH ROW EXECUTE FUNCTION catalog.same_tenant_as_parent();

ALTER TABLE "catalog"."price_campaign" ADD COLUMN "seasonId" UUID;
ALTER TABLE "catalog"."price_campaign" ADD CONSTRAINT "price_campaign_seasonId_fkey"
  FOREIGN KEY ("seasonId") REFERENCES "catalog"."season"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "price_campaign_season_once" ON "catalog"."price_campaign"("seasonId", "variantId", "startsAt")
  WHERE "seasonId" IS NOT NULL;

-- Row-Level Security: shared-read, as the catalog.
ALTER TABLE "catalog"."season" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."season" FORCE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."season_price" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."season_price" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "catalog"."season", "catalog"."season_price" TO txnet_app, txnet_cross_tenant;
CREATE POLICY tenant_isolation ON "catalog"."season" AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id()) WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "catalog"."season" AS PERMISSIVE FOR ALL TO txnet_cross_tenant USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON "catalog"."season_price" AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id()) WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "catalog"."season_price" AS PERMISSIVE FOR ALL TO txnet_cross_tenant USING (true) WITH CHECK (true);

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_season_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_season_update';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_season_price_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_season_price_remove';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'season';
