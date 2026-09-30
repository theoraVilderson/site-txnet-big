-- F-114-e-d (user 2026-09-30): "reset link" breaks the link in every app that
-- holds it, and the per-user bucket (5 per 15 minutes) allowed 480 a day. The
-- owner now resets one Grant at most 3 times in any 24 hours; the count is
-- this table, one row per reset on the owner's path. Staff and a reseller's
-- admin write none — theirs are audited in the admin audit log.
--
-- Its Grant's tenant's (`same_tenant()`), history (`grant_link_reset_is_history`),
-- strictly tenant-scoped RLS, as `grant_renewal`.
--
-- Additive; rollback: DROP TABLE "entitlement"."grant_link_reset" and the
-- function `entitlement.grant_link_reset_is_history()`.

CREATE TABLE "entitlement"."grant_link_reset" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grant_link_reset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "grant_link_reset_grantId_createdAt_idx" ON "entitlement"."grant_link_reset"("grantId", "createdAt");
CREATE INDEX "grant_link_reset_tenantId_idx" ON "entitlement"."grant_link_reset"("tenantId");

ALTER TABLE "entitlement"."grant_link_reset" ADD CONSTRAINT "grant_link_reset_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "entitlement"."grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER grant_link_reset_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "grantId" ON "entitlement"."grant_link_reset"
  FOR EACH ROW EXECUTE FUNCTION entitlement.same_tenant();

CREATE FUNCTION entitlement.grant_link_reset_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'grant_link_reset_is_history: a reset is never changed or deleted'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER grant_link_reset_is_history BEFORE UPDATE OR DELETE ON "entitlement"."grant_link_reset"
  FOR EACH ROW EXECUTE FUNCTION entitlement.grant_link_reset_is_history();

ALTER TABLE entitlement.grant_link_reset ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.grant_link_reset FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement"."grant_link_reset" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "entitlement"."grant_link_reset"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "entitlement"."grant_link_reset"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
