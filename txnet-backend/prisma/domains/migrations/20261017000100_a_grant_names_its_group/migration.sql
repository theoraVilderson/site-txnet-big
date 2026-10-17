-- F-027-er — a Grant names its group (ADR-0127 decision 4; entitlement
-- `data-model.md`).
--
-- Until now a Grant's group was only inferred, `variantId ->
-- product_variant.panelGroupId`: a migrated Grant (no variant) had none, and
-- moving a Grant to another group would have meant changing what was bought.
-- `grant.panelGroupId` is set at issue from the variant and is the Grant's own
-- from then on: a renewal keeps it, a catalog edit of the variant's group
-- never reaches a Grant already sold.
--
-- The back-fill copies each Grant's variant's group, so every reader that
-- switches to the Grant reads exactly what it read before: nothing moves. It
-- touches no column `sub_grant_changed` or `grant_status_one_way` watches.
--
-- Rollback: drop the column (its index, key and trigger go with it), the
-- function, and restore `sub_grant_changed` and its function from
-- 20260926000600.

-- AlterTable
ALTER TABLE "entitlement"."grant" ADD COLUMN "panelGroupId" UUID;

-- CreateIndex
CREATE INDEX "grant_panelGroupId_idx" ON "entitlement"."grant"("panelGroupId");

-- AddForeignKey
ALTER TABLE "entitlement"."grant" ADD CONSTRAINT "grant_panelGroupId_fkey" FOREIGN KEY ("panelGroupId") REFERENCES "network"."panel_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Back-fill: the group each Grant's variant names today.
UPDATE "entitlement"."grant" g
   SET "panelGroupId" = v."panelGroupId"
  FROM "catalog"."product_variant" v
 WHERE v."id" = g."variantId" AND v."panelGroupId" IS NOT NULL;

-- -----------------------------------------------------------------------------
-- A Grant names a platform group or its own tenant's — as its variant must
-- (`catalog.variant_panel_group_fits`). A reseller's user on a platform
-- product is served by a platform group (tenant null); never another
-- reseller's.
-- -----------------------------------------------------------------------------
CREATE FUNCTION entitlement.grant_panel_group_fits() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  group_tenant uuid;
BEGIN
  IF NEW."panelGroupId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "tenantId" INTO group_tenant FROM network.panel_group WHERE id = NEW."panelGroupId";
  -- Under RLS another tenant's group is not found, so not found is refused.
  IF NOT FOUND OR (group_tenant IS NOT NULL AND group_tenant IS DISTINCT FROM NEW."tenantId") THEN
    RAISE EXCEPTION 'panel_group_foreign_group: grant % names no group it may use', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER grant_panel_group_fits BEFORE INSERT OR UPDATE OF "tenantId", "panelGroupId" ON "entitlement"."grant"
  FOR EACH ROW EXECUTE FUNCTION entitlement.grant_panel_group_fits();

-- -----------------------------------------------------------------------------
-- `/sub` reads the Grant's group now (sub-service `store.go`), so a change of
-- it drops the cached render like any other column `/sub` reads.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION entitlement.notify_sub_grant_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     OLD.status IS DISTINCT FROM NEW.status OR
     OLD."subscriptionTokenHash" IS DISTINCT FROM NEW."subscriptionTokenHash" OR
     OLD."tenantId" IS DISTINCT FROM NEW."tenantId" OR
     OLD."endsAt" IS DISTINCT FROM NEW."endsAt" OR
     OLD.quotas IS DISTINCT FROM NEW.quotas OR
     OLD."billingMode" IS DISTINCT FROM NEW."billingMode" OR
     OLD."trafficUnlimited" IS DISTINCT FROM NEW."trafficUnlimited" OR
     OLD."panelGroupId" IS DISTINCT FROM NEW."panelGroupId" THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'grant', 'id', OLD.id)::text);
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER sub_grant_changed ON entitlement."grant";
CREATE TRIGGER sub_grant_changed
  AFTER UPDATE OF status, "subscriptionTokenHash", "tenantId", "endsAt", quotas, "billingMode", "trafficUnlimited", "panelGroupId" OR DELETE
  ON entitlement."grant"
  FOR EACH ROW EXECUTE FUNCTION entitlement.notify_sub_grant_changed();
