-- F-311-m: an admin deletes a user's service. The Grant is `cancelled`
-- (`statusReason = admin_deleted`) and its configs `desiredRemote = absent`
-- at once; both are existing columns. What is new is the record of the
-- choice the admin made (user, 2026-09-26): whether the remainder went back
-- to the wallet (F-027-r), the reason, and what was credited — one
-- `grant_deletion` row per Grant, since `cancelled` is terminal.
--
-- 1. Its Grant's tenant's (`entitlement.same_tenant()`, the adjustment's branch).
-- 2. History: never changed or deleted (`grant_deletion_is_history`).
-- 3. Strictly tenant-scoped RLS, as `grant_duration_change`.
-- 4. Money only when asked for: an amount goes with its wallet row, both only
--    with `refundRemainder`; `refundSkipped` (why nothing was credited) only
--    for a refund asked for that credited nothing.
-- `actorUserId` and `walletTransactionId` have no foreign key: the admin may be
-- the platform's staff, and the wallet row is another domain's.
--
-- Additive; rollback: DROP TABLE "entitlement"."grant_deletion" and the
-- function `entitlement.grant_deletion_is_history()`.

CREATE TABLE "entitlement"."grant_deletion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "statusBefore" "entitlement"."GrantStatus" NOT NULL,
    "refundRemainder" BOOLEAN NOT NULL,
    "refundedAmount" DECIMAL(18,2),
    "walletTransactionId" UUID,
    "refundSkipped" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grant_deletion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grant_deletion_has_reason" CHECK (length(btrim("reason")) > 0),
    CONSTRAINT "grant_deletion_refund_asked" CHECK (
        ("refundedAmount" IS NULL) = ("walletTransactionId" IS NULL)
        AND ("refundedAmount" IS NULL OR ("refundRemainder" AND "refundedAmount" > 0 AND "refundSkipped" IS NULL))
        AND ("refundSkipped" IS NULL OR "refundRemainder"))
);

CREATE UNIQUE INDEX "grant_deletion_grantId_key" ON "entitlement"."grant_deletion"("grantId");
CREATE INDEX "grant_deletion_tenantId_idx" ON "entitlement"."grant_deletion"("tenantId");

ALTER TABLE "entitlement"."grant_deletion" ADD CONSTRAINT "grant_deletion_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "entitlement"."grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER grant_deletion_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "grantId" ON "entitlement"."grant_deletion"
  FOR EACH ROW EXECUTE FUNCTION entitlement.same_tenant();

CREATE FUNCTION entitlement.grant_deletion_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'grant_deletion_is_history: an admin''s delete of a Grant is never changed or deleted'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER grant_deletion_is_history BEFORE UPDATE OR DELETE ON "entitlement"."grant_deletion"
  FOR EACH ROW EXECUTE FUNCTION entitlement.grant_deletion_is_history();

ALTER TABLE entitlement.grant_deletion ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.grant_deletion FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement"."grant_deletion" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "entitlement"."grant_deletion"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "entitlement"."grant_deletion"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
