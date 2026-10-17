-- F-027-es — releasing an inbound from groups with live configs there is the
-- admin's choice, run as a job (ADR-0127 decision 6): `release_move` moves
-- each config to its group's next placement, `release_empty` retires it there
-- and settles a Grant left with no line as the job's `orphans` says. A kind of
-- F-311-ad's config move job, so it reuses its items, drain and progress event.
--
-- `inbound_release` holds, while the job runs, which (group, inbound) is
-- being released: fulfilment places none of that group's Grants there, and
-- the listing itself changes only when the job ends. A cancel removes the
-- rows and changes nothing else. Policied as `panel_group_member_inbound`:
-- a platform group's row has `tenantId` null, read by every tenant's fulfilment.
--
-- Expand only: a new type, two nullable columns, `toPanelId` made nullable
-- (a release has none), one table. Rollback: remove the table, the two
-- columns and the type; `toPanelId` NOT NULL again while no release job exists.

CREATE TYPE "network"."ConfigMoveJobKind" AS ENUM ('to_panel', 'release_move', 'release_empty');

ALTER TABLE "network"."config_move_job"
  ADD COLUMN "kind" "network"."ConfigMoveJobKind" NOT NULL DEFAULT 'to_panel',
  ADD COLUMN "orphans" "network"."EvictOrphans",
  ALTER COLUMN "toPanelId" DROP NOT NULL,
  ADD CONSTRAINT "config_move_job_kind_fits" CHECK (
    ("kind" = 'to_panel' AND "toPanelId" IS NOT NULL AND "orphans" IS NULL)
    OR ("kind" = 'release_move' AND "toPanelId" IS NULL AND "orphans" IS NULL)
    OR ("kind" = 'release_empty' AND "toPanelId" IS NULL AND "orphans" IS NOT NULL));

CREATE TABLE "network"."inbound_release" (
    "groupId" UUID NOT NULL,
    "panelId" UUID NOT NULL,
    "inboundRemoteId" TEXT NOT NULL,
    "tenantId" UUID,
    "jobId" UUID NOT NULL,

    CONSTRAINT "inbound_release_pkey" PRIMARY KEY ("groupId", "panelId", "inboundRemoteId"),
    CONSTRAINT "inbound_release_groupId_panelId_fkey" FOREIGN KEY ("groupId", "panelId") REFERENCES "network"."panel_group_member"("groupId", "panelId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inbound_release_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "network"."config_move_job"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "inbound_release_jobId_idx" ON "network"."inbound_release"("jobId");

ALTER TABLE network.inbound_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.inbound_release FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "network"."inbound_release" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "network"."inbound_release"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "network"."inbound_release"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
