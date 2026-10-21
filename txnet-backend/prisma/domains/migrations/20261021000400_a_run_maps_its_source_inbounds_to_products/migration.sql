-- F-206 (D-63): the dry run of an import.
--
--   migration_inbound — one inbound of the source panel as the snapshot read
--                       it, and the reseller's prepaid product variant its
--                       clients become (user's call 2026-10-21: an inbound
--                       maps to a product, not to a server, so an imported
--                       Grant renews and tops up as any other). Null until
--                       chosen; a run with a mapped-to-nothing inbound that
--                       holds clients is not previewed.
--   migration_run.failureReason   — why the last preview went back to `draft`
--                       (the source's refusal, or `inbounds_unmapped`).
--   migration_run.workerClaimedAt — the drain's lease on the run, so two
--                       ticks never read the source or commit it at once.
--   MigrationSkipReason.unreadable — a client the snapshot answered in a shape
--                       the import does not take (catalog §16: parsed, never
--                       trusted).
--
-- Nothing outside the migration tables is written (invariant 32). Additive;
-- rollback: drop the table and both columns (the enum value stays: Postgres
-- cannot drop one, and an unused value is harmless).

ALTER TYPE "entitlement"."MigrationSkipReason" ADD VALUE 'unreadable';

ALTER TABLE "entitlement"."migration_run" ADD COLUMN "failureReason" TEXT;
ALTER TABLE "entitlement"."migration_run" ADD COLUMN "workerClaimedAt" TIMESTAMP(3);

CREATE TABLE "entitlement"."migration_inbound" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "inboundRemoteId" TEXT NOT NULL,
    "tag" TEXT NOT NULL DEFAULT '',
    "protocol" TEXT NOT NULL DEFAULT '',
    "clientCount" INTEGER NOT NULL DEFAULT 0,
    "variantId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "migration_inbound_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "migration_inbound_client_count_not_negative" CHECK ("clientCount" >= 0)
);

CREATE UNIQUE INDEX "migration_inbound_runId_inboundRemoteId_key" ON "entitlement"."migration_inbound"("runId", "inboundRemoteId");
CREATE INDEX "migration_inbound_tenantId_idx" ON "entitlement"."migration_inbound"("tenantId");

ALTER TABLE "entitlement"."migration_inbound" ADD CONSTRAINT "migration_inbound_runId_tenantId_fkey"
    FOREIGN KEY ("runId", "tenantId") REFERENCES "entitlement"."migration_run"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Tenant data, as its run
-- -----------------------------------------------------------------------------
ALTER TABLE entitlement.migration_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.migration_inbound FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement"."migration_inbound" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "entitlement"."migration_inbound"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "entitlement"."migration_inbound"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
