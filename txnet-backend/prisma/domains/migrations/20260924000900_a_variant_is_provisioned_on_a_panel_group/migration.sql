-- F-027-bk — a variant is provisioned on a panel group (catalog §7.3).
--
-- A group names how it places a Grant (`strategy`), how many healthy members a
-- Grant needs (`minHealthyPanels`) and how long a client keeps a subscription
-- (`subscriptionTtlSeconds`, which draining waits twice). A member names its
-- role; `drain` is how a panel leaves without cutting anyone off (F-027-bm).
-- Fulfilment is F-027-bl: nothing reads these tables yet.
--
-- `catalog.product_variant.panelGroupId` has existed since F-026-a with no FK
-- "until that unit is built". It is built: the FK lands here. No variant on
-- dev names a group, so the constraint validates against nothing.
--
-- Tenancy is the part a CHECK cannot hold, so three triggers do:
--   * a member panel is a platform panel or its group's tenant's — a platform
--     group holding one reseller's dedicated panel would serve everyone's
--     users from it;
--   * a group's tenant never changes, and a panel's tenant cannot move out
--     from under a group that holds it;
--   * a variant names a platform group or its own tenant's.
--
-- Additive: two enums, two tables, one FK. Rollback: drop the FK, the two
-- tables, the three functions and the two enums.

-- CreateEnum
CREATE TYPE "network"."PanelGroupStrategy" AS ENUM ('mirror', 'priority', 'weighted');

-- CreateEnum
CREATE TYPE "network"."PanelGroupMemberRole" AS ENUM ('primary', 'replica', 'drain');

-- CreateTable
CREATE TABLE "network"."panel_group" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "name" TEXT NOT NULL,
    "strategy" "network"."PanelGroupStrategy" NOT NULL DEFAULT 'mirror',
    "minHealthyPanels" INTEGER NOT NULL DEFAULT 1,
    "subscriptionTtlSeconds" INTEGER NOT NULL DEFAULT 3600,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "panel_group_pkey" PRIMARY KEY ("id"),
    -- A group that activates a Grant with no panel activates one nobody serves.
    CONSTRAINT "panel_group_min_healthy_positive" CHECK ("minHealthyPanels" >= 1),
    CONSTRAINT "panel_group_ttl_positive" CHECK ("subscriptionTtlSeconds" > 0)
);

-- CreateTable
CREATE TABLE "network"."panel_group_member" (
    "groupId" UUID NOT NULL,
    "panelId" UUID NOT NULL,
    "tenantId" UUID,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "role" "network"."PanelGroupMemberRole" NOT NULL DEFAULT 'primary',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "panel_group_member_pkey" PRIMARY KEY ("groupId","panelId"),
    CONSTRAINT "panel_group_member_priority_non_negative" CHECK ("priority" >= 0),
    -- A zero weight is a member `weighted` never picks: that is `drain`.
    CONSTRAINT "panel_group_member_weight_positive" CHECK ("weight" >= 1)
);

-- CreateIndex
CREATE INDEX "panel_group_tenantId_idx" ON "network"."panel_group"("tenantId");

-- CreateIndex
CREATE INDEX "panel_group_member_panelId_idx" ON "network"."panel_group_member"("panelId");

-- CreateIndex
CREATE INDEX "panel_group_member_tenantId_idx" ON "network"."panel_group_member"("tenantId");

-- AddForeignKey
ALTER TABLE "catalog"."product_variant" ADD CONSTRAINT "product_variant_panelGroupId_fkey" FOREIGN KEY ("panelGroupId") REFERENCES "network"."panel_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network"."panel_group_member" ADD CONSTRAINT "panel_group_member_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "network"."panel_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network"."panel_group_member" ADD CONSTRAINT "panel_group_member_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "network"."panel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- A member carries its group's tenant, and its panel is that tenant's or the
-- platform's
-- -----------------------------------------------------------------------------
CREATE FUNCTION network.panel_group_member_fits() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  group_tenant uuid;
  panel_tenant uuid;
BEGIN
  SELECT "tenantId" INTO group_tenant FROM network.panel_group WHERE id = NEW."groupId";
  IF NOT FOUND OR group_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'panel_group_tenant_mismatch: a member must carry its group''s tenant'
      USING ERRCODE = '23514';
  END IF;
  -- Runs as the caller, under RLS: another tenant's panel is not found, and
  -- not found is refused (the FK has already said it exists, or will).
  SELECT "tenantId" INTO panel_tenant FROM network.panel WHERE id = NEW."panelId";
  IF NOT FOUND OR (panel_tenant IS NOT NULL AND panel_tenant IS DISTINCT FROM group_tenant) THEN
    RAISE EXCEPTION 'panel_group_foreign_panel: panel % is another tenant''s', NEW."panelId"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER panel_group_member_fits BEFORE INSERT OR UPDATE OF "tenantId", "groupId", "panelId" ON "network"."panel_group_member"
  FOR EACH ROW EXECUTE FUNCTION network.panel_group_member_fits();

CREATE FUNCTION network.panel_group_tenant_is_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
    RAISE EXCEPTION 'panel_group_tenant_is_fixed: a group''s tenant never changes'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER panel_group_tenant_is_fixed BEFORE UPDATE OF "tenantId" ON "network"."panel_group"
  FOR EACH ROW EXECUTE FUNCTION network.panel_group_tenant_is_fixed();

-- A platform panel taken over by a tenant must first leave every group that
-- is not that tenant's.
CREATE FUNCTION network.panel_keeps_its_groups() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM network.panel_group_member
    WHERE "panelId" = NEW.id AND "tenantId" IS DISTINCT FROM NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'panel_group_foreign_panel: panel % is in another tenant''s group', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER panel_keeps_its_groups AFTER UPDATE OF "tenantId" ON "network"."panel"
  FOR EACH ROW EXECUTE FUNCTION network.panel_keeps_its_groups();

-- -----------------------------------------------------------------------------
-- A variant names a platform group or its own tenant's
-- -----------------------------------------------------------------------------
CREATE FUNCTION catalog.variant_panel_group_fits() RETURNS trigger
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
    RAISE EXCEPTION 'panel_group_foreign_group: variant % names no group it may use', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER product_variant_panel_group_fits BEFORE INSERT OR UPDATE OF "tenantId", "panelGroupId" ON "catalog"."product_variant"
  FOR EACH ROW EXECUTE FUNCTION catalog.variant_panel_group_fits();

-- -----------------------------------------------------------------------------
-- Row-Level Security: shared-read, as `network.panel`
-- (20260909001500_row_level_security_all_tables, list B)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'network.panel_group',
    'network.panel_group_member'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);

    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);

    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END
$$;
