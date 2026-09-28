-- F-311-u1: a bulk act on a reseller's Grants (F-311-u) is applied once per
-- `requestId`. One row per Grant of a request: a repeat answers the stored
-- outcomes and acts on no Grant twice — +3 days never becomes +6.
--
-- Primary key (tenantId, requestId, grantId): the key a concurrent repeat
-- collides on inside its act's transaction, which then rolls back. Tenant-
-- scoped RLS, as every tenant table. No foreign keys: a `grant_not_found`
-- outcome names an id that is not the reseller's Grant, or no Grant at all.
--
-- Additive; rollback: DROP TABLE "billing"."grant_bulk_outcome".

CREATE TABLE "billing"."grant_bulk_outcome" (
    "tenantId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "actorUserId" UUID NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "outcome" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grant_bulk_outcome_pkey" PRIMARY KEY ("tenantId", "requestId", "grantId")
);

ALTER TABLE billing.grant_bulk_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.grant_bulk_outcome FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."grant_bulk_outcome" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "billing"."grant_bulk_outcome"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "billing"."grant_bulk_outcome"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
