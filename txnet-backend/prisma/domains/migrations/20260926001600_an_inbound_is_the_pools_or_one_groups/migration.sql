-- F-027-ch — an inbound is the default pool's or one group's (ADR-0090
-- decision 3, D-48; network `contract.inbounds.md` rule 3a).
--
-- `panel_group_member_inbound`: an inbound assigned to one membership. It
-- leaves the panel's default pool, and only that group places on it. The
-- unique `(panelId, inboundRemoteId)` holds "at most one group" when two
-- assignments race. A membership with no row sells the pool — `sold` inbounds
-- no membership holds — so today's state, "every group sells the pool", is
-- exactly this table empty: **the migration moves no data**, and every placed
-- config stays where it is.
--
-- Both keys cascade: removing a member or a panel's inbound row drops the
-- assignment with it. Rollback: drop the table and its function.

-- CreateTable
CREATE TABLE "network"."panel_group_member_inbound" (
    "groupId" UUID NOT NULL,
    "panelId" UUID NOT NULL,
    "inboundRemoteId" TEXT NOT NULL,
    "tenantId" UUID,

    CONSTRAINT "panel_group_member_inbound_pkey" PRIMARY KEY ("groupId","panelId","inboundRemoteId")
);

-- CreateIndex
CREATE UNIQUE INDEX "panel_group_member_inbound_panelId_inboundRemoteId_key" ON "network"."panel_group_member_inbound"("panelId", "inboundRemoteId");

-- CreateIndex
CREATE INDEX "panel_group_member_inbound_tenantId_idx" ON "network"."panel_group_member_inbound"("tenantId");

-- AddForeignKey
ALTER TABLE "network"."panel_group_member_inbound" ADD CONSTRAINT "panel_group_member_inbound_groupId_panelId_fkey" FOREIGN KEY ("groupId", "panelId") REFERENCES "network"."panel_group_member"("groupId", "panelId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network"."panel_group_member_inbound" ADD CONSTRAINT "panel_group_member_inbound_panelId_inboundRemoteId_fkey" FOREIGN KEY ("panelId", "inboundRemoteId") REFERENCES "network"."panel_inbound"("panelId", "remoteId") ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- An assignment carries its membership's tenant
-- -----------------------------------------------------------------------------
CREATE FUNCTION network.panel_group_member_inbound_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT "tenantId" INTO NEW."tenantId" FROM network.panel_group_member
   WHERE "groupId" = NEW."groupId" AND "panelId" = NEW."panelId";
  RETURN NEW;
END
$$;

CREATE TRIGGER panel_group_member_inbound_tenant BEFORE INSERT OR UPDATE OF "tenantId", "groupId", "panelId" ON "network"."panel_group_member_inbound"
  FOR EACH ROW EXECUTE FUNCTION network.panel_group_member_inbound_tenant();

-- -----------------------------------------------------------------------------
-- Row-Level Security: shared-read, as `network.panel_group_member`
-- -----------------------------------------------------------------------------
ALTER TABLE network.panel_group_member_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.panel_group_member_inbound FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "network"."panel_group_member_inbound" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "network"."panel_group_member_inbound"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "network"."panel_group_member_inbound"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
