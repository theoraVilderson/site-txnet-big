-- F-311-i: an admin moves a Grant's end by ±N days or to a date. Duration is
-- `endsAt`, not a quota metric (§4.5), so `quota_adjustment` cannot hold it:
-- each move is one `grant_duration_change` row — the actor, the end before,
-- the end after, the reason.
--
-- 1. Its Grant's tenant's (`entitlement.same_tenant()`, the adjustment's branch).
-- 2. History: never changed or deleted (`grant_duration_change_is_history`).
-- 3. Strictly tenant-scoped RLS, as `quota_adjustment`.
-- `actorUserId` has no foreign key: the admin may be the platform's staff.
--
-- Additive; rollback: DROP TABLE "entitlement"."grant_duration_change" and
-- the function `entitlement.grant_duration_change_is_history()`.

CREATE TABLE "entitlement"."grant_duration_change" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "endsAtBefore" TIMESTAMP(3) NOT NULL,
    "endsAtAfter" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grant_duration_change_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grant_duration_change_moves" CHECK ("endsAtAfter" <> "endsAtBefore"),
    CONSTRAINT "grant_duration_change_has_reason" CHECK (length(btrim("reason")) > 0)
);

CREATE INDEX "grant_duration_change_grantId_createdAt_idx" ON "entitlement"."grant_duration_change"("grantId", "createdAt");
CREATE INDEX "grant_duration_change_tenantId_idx" ON "entitlement"."grant_duration_change"("tenantId");

ALTER TABLE "entitlement"."grant_duration_change" ADD CONSTRAINT "grant_duration_change_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "entitlement"."grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER grant_duration_change_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "grantId" ON "entitlement"."grant_duration_change"
  FOR EACH ROW EXECUTE FUNCTION entitlement.same_tenant();

CREATE FUNCTION entitlement.grant_duration_change_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'grant_duration_change_is_history: a change of days is never changed or deleted; write another'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER grant_duration_change_is_history BEFORE UPDATE OR DELETE ON "entitlement"."grant_duration_change"
  FOR EACH ROW EXECUTE FUNCTION entitlement.grant_duration_change_is_history();

ALTER TABLE entitlement.grant_duration_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.grant_duration_change FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement"."grant_duration_change" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "entitlement"."grant_duration_change"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "entitlement"."grant_duration_change"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
