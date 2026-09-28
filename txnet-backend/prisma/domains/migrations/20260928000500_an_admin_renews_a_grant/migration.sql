-- F-311-d: an admin renews a user's Grant in place — `renewGrant`, source
-- `admin_grant`, no money (user, 2026-09-28). With no amount named, the
-- renewal is one period of the plan the user bought.
--
-- 1. `grant.periodDays`: the plan's period, copied at issue as `quotas` is,
--    because `product_variant.durationDays` can be patched after the sale.
--    Backfilled from the variant as it stands today — the best record there
--    is for a Grant issued before this; a Grant with no variant stays null
--    and its admin types the amount.
-- 2. `grant_renewal`: one row per request (`requestId` unique, so a repeated
--    click answers the first renewal), the renewal's record — days alone
--    write no `quota_adjustment` row. Its Grant's tenant's (`same_tenant()`),
--    history (`grant_renewal_is_history`), strictly tenant-scoped RLS, as
--    `grant_duration_change`. `actorUserId` has no foreign key: the admin may
--    be the platform's staff.
--
-- Additive; rollback: DROP TABLE "entitlement"."grant_renewal", the function
-- `entitlement.grant_renewal_is_history()`, and the column "periodDays".

ALTER TABLE "entitlement"."grant" ADD COLUMN "periodDays" INTEGER;

UPDATE "entitlement"."grant" g
   SET "periodDays" = v."durationDays"
  FROM "catalog"."product_variant" v
 WHERE g."variantId" = v."id" AND v."durationDays" IS NOT NULL;

CREATE TABLE "entitlement"."grant_renewal" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "plan" BOOLEAN NOT NULL,
    "bytes" BIGINT NOT NULL,
    "days" INTEGER NOT NULL,
    "forgivenBytes" BIGINT NOT NULL,
    "purchasedBytesBefore" BIGINT NOT NULL,
    "purchasedBytesAfter" BIGINT NOT NULL,
    "endsAtBefore" TIMESTAMP(3),
    "endsAtAfter" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grant_renewal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grant_renewal_adds" CHECK ("bytes" >= 0 AND "days" >= 0 AND ("bytes" > 0 OR "days" > 0) AND "forgivenBytes" >= 0)
);

CREATE UNIQUE INDEX "grant_renewal_requestId_key" ON "entitlement"."grant_renewal"("requestId");
CREATE INDEX "grant_renewal_grantId_createdAt_idx" ON "entitlement"."grant_renewal"("grantId", "createdAt");
CREATE INDEX "grant_renewal_tenantId_idx" ON "entitlement"."grant_renewal"("tenantId");

ALTER TABLE "entitlement"."grant_renewal" ADD CONSTRAINT "grant_renewal_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "entitlement"."grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER grant_renewal_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "grantId" ON "entitlement"."grant_renewal"
  FOR EACH ROW EXECUTE FUNCTION entitlement.same_tenant();

CREATE FUNCTION entitlement.grant_renewal_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'grant_renewal_is_history: a renewal is never changed or deleted; write another'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER grant_renewal_is_history BEFORE UPDATE OR DELETE ON "entitlement"."grant_renewal"
  FOR EACH ROW EXECUTE FUNCTION entitlement.grant_renewal_is_history();

ALTER TABLE entitlement.grant_renewal ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.grant_renewal FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement"."grant_renewal" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "entitlement"."grant_renewal"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "entitlement"."grant_renewal"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
