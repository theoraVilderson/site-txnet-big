-- F-033-g — a tenant's weekly support hours (user, 2026-10-03): one schedule
-- per tenant, on the tenant's own wall clock (`tenant.tenant.timezone`,
-- ADR-0108). No row at all means always open — presence alone decides `live`.
-- Written whole by `PUT /api/support/settings/hours` (`support.manage`).
--
-- Additive. Rollback: DROP TABLE support.working_hours.

CREATE TABLE "support"."working_hours" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    -- 0 = Sunday … 6 = Saturday, as `Date.getDay()` and `wallClock().weekday`.
    "weekday" SMALLINT NOT NULL,
    -- Minutes past local midnight; `endMinute` exclusive, 1440 = midnight next day.
    "startMinute" SMALLINT NOT NULL,
    "endMinute" SMALLINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "working_hours_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "working_hours_weekday" CHECK ("weekday" BETWEEN 0 AND 6),
    CONSTRAINT "working_hours_span" CHECK ("startMinute" >= 0 AND "startMinute" < "endMinute" AND "endMinute" <= 1440)
);

CREATE INDEX "working_hours_tenantId_weekday_idx" ON "support"."working_hours"("tenantId", "weekday");

ALTER TABLE support.working_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE support.working_hours FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON support.working_hours TO txnet_app, txnet_cross_tenant;
CREATE POLICY tenant_isolation ON support.working_hours
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON support.working_hours
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
