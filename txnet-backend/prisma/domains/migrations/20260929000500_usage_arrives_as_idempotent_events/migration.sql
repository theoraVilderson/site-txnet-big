-- F-118-f (D-58, ADR-0105 decision 5): usage arrives as idempotent events that
-- advance a Grant's `grant_meter.consumed`.
--
-- 1. `usage_event`: one row per reported use, on the `(grantId, meterKey)` of a
--    `grant_meter` row — usage on a meter the Grant was not sold with has no
--    row to land on. `(source, idempotencyKey)` is unique and its insert is the
--    deduplication: the writer uses ON CONFLICT DO NOTHING, so a copy aborts no
--    transaction and advances nothing.
-- 2. Append-only: the application roles are granted SELECT and INSERT only.
-- 3. Its Grant's tenant's (`entitlement.same_tenant()`), strictly tenant-scoped
--    RLS, like `grant_meter`.
--
-- Additive; rollback: DROP TABLE "billing"."usage_event".

CREATE TABLE "billing"."usage_event" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "meterKey" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "usage_event_quantity_positive" CHECK ("quantity" > 0),
    CONSTRAINT "usage_event_source_present" CHECK (length("source") > 0),
    CONSTRAINT "usage_event_key_present" CHECK (length("idempotencyKey") > 0)
);

CREATE UNIQUE INDEX "usage_event_source_idempotencyKey_key" ON "billing"."usage_event"("source", "idempotencyKey");
CREATE INDEX "usage_event_grantId_meterKey_occurredAt_idx" ON "billing"."usage_event"("grantId", "meterKey", "occurredAt");
CREATE INDEX "usage_event_tenantId_idx" ON "billing"."usage_event"("tenantId");

ALTER TABLE "billing"."usage_event" ADD CONSTRAINT "usage_event_grantId_meterKey_fkey" FOREIGN KEY ("grantId", "meterKey") REFERENCES "entitlement"."grant_meter"("grantId", "meterKey") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER usage_event_same_tenant BEFORE INSERT ON "billing"."usage_event"
  FOR EACH ROW EXECUTE FUNCTION entitlement.same_tenant();

ALTER TABLE billing.usage_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.usage_event FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON "billing"."usage_event" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "billing"."usage_event"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "billing"."usage_event"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
