-- F-033-h — SLA (user, 2026-10-03): first-response and resolution targets per
-- tenant and priority, counted in the tenant's working minutes (F-033-g's
-- schedule; none = the wall clock), the resolution clock paused while the
-- thread waits on the user. Priority stays queue position only (§11.5).
--
-- `sla_policy` rows with `tenantId` NULL are the platform's defaults, read by
-- every tenant (shared-read, as `support_category`); a tenant's own row for a
-- priority replaces the default for that priority.
--
-- Additive: the new conversation columns are nullable / default 0, and an
-- existing open thread gets its due times on its next write.
-- Rollback: DROP TABLE support.sla_policy; drop the five columns.

CREATE TABLE "support"."sla_policy" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "priority" "support"."ConversationPriority" NOT NULL,
    "firstResponseMinutes" INTEGER NOT NULL,
    "resolutionMinutes" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sla_policy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sla_policy_targets" CHECK ("firstResponseMinutes" > 0 AND "resolutionMinutes" >= "firstResponseMinutes")
);

-- One row per (tenant, priority). The NULL defaults are written by this
-- migration alone: RLS refuses a tenant writing `tenantId` NULL.
CREATE UNIQUE INDEX "sla_policy_tenantId_priority_key" ON "support"."sla_policy"("tenantId", "priority");

ALTER TABLE "support"."conversation"
  ADD COLUMN "firstResponseDueAt" TIMESTAMP(3),
  ADD COLUMN "resolutionDueAt" TIMESTAMP(3),
  -- Set while the resolution clock is stopped (waiting on the user, or resolved).
  ADD COLUMN "slaPausedAt" TIMESTAMP(3),
  -- Working seconds the resolution clock has spent stopped, so far.
  ADD COLUMN "slaPausedSeconds" INTEGER NOT NULL DEFAULT 0,
  -- The clock running now: first response until it is given, then resolution;
  -- NULL while stopped. What the agent queue orders by after priority.
  ADD COLUMN "slaDueAt" TIMESTAMP(3);

CREATE INDEX "conversation_tenantId_status_priority_slaDueAt_idx"
  ON "support"."conversation"("tenantId", "status", "priority", "slaDueAt");

ALTER TABLE support.sla_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE support.sla_policy FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON support.sla_policy TO txnet_app, txnet_cross_tenant;
CREATE POLICY tenant_isolation ON support.sla_policy
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON support.sla_policy
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

-- The platform's defaults, in working minutes.
INSERT INTO support.sla_policy (id, "tenantId", priority, "firstResponseMinutes", "resolutionMinutes") VALUES
  (gen_random_uuid(), NULL, 'urgent', 30, 240),
  (gen_random_uuid(), NULL, 'high', 60, 480),
  (gen_random_uuid(), NULL, 'normal', 240, 1440),
  (gen_random_uuid(), NULL, 'low', 480, 2880);
