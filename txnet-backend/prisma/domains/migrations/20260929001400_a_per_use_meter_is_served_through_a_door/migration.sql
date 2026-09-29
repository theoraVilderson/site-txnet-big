-- F-118-h (D-58, ADR-0105 decision 7): the per-use door. Work on a per-use
-- meter (`vpn.config.regenerate` first) is authorized before it is done — the
-- money debited (prepaid) or held (postpaid), and on a reseller's Grant the
-- wholesale units bought on its billing wallet first — and the authorization
-- is a token: `commit` records the actual use, `cancel` or its expiry gives
-- back what no open token still needs.
--
-- 1. `usage_authorization`: one row per token, on the `(grantId, meterKey)` of
--    a `grant_meter` row. `(grantId, meterKey, idempotencyKey)` is unique: the
--    same key answers the same token. A settled token (`committed`,
--    `cancelled`, `expired`) has `settledAt`; only a committed one has a
--    `committedQuantity`, never above what was authorized.
-- 2. Its Grant's tenant's (`entitlement.same_tenant()`), strictly tenant-scoped
--    RLS, like `usage_event`. Never deleted: SELECT, INSERT, UPDATE only.
-- 3. `metered_usage_refund`: the reseller-ledger credit that gives back
--    wholesale units bought and not used — the undo of `metered_usage_charge`.
--
-- Additive; rollback: DROP TABLE "billing"."usage_authorization"; DROP TYPE
-- "billing"."UsageAuthorizationStatus" (an enum value cannot be dropped).

ALTER TYPE "tenant"."TenantBillingReasonType" ADD VALUE 'metered_usage_refund';

CREATE TYPE "billing"."UsageAuthorizationStatus" AS ENUM ('open', 'committed', 'cancelled', 'expired');

CREATE TABLE "billing"."usage_authorization" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "meterKey" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "status" "billing"."UsageAuthorizationStatus" NOT NULL DEFAULT 'open',
    "boughtUnits" BIGINT NOT NULL DEFAULT 0,
    "heldAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "wholesaleUnits" BIGINT NOT NULL DEFAULT 0,
    "committedQuantity" BIGINT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "usage_authorization_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "usage_authorization_quantity_positive" CHECK ("quantity" > 0),
    CONSTRAINT "usage_authorization_key_present" CHECK (length("idempotencyKey") > 0),
    CONSTRAINT "usage_authorization_money_non_negative" CHECK ("boughtUnits" >= 0 AND "heldAmount" >= 0 AND "wholesaleUnits" >= 0),
    CONSTRAINT "usage_authorization_settled_at" CHECK (("status" = 'open') = ("settledAt" IS NULL)),
    CONSTRAINT "usage_authorization_committed_quantity" CHECK (
      ("status" = 'committed') = ("committedQuantity" IS NOT NULL)
      AND ("committedQuantity" IS NULL OR ("committedQuantity" >= 0 AND "committedQuantity" <= "quantity"))
    )
);

CREATE UNIQUE INDEX "usage_authorization_grantId_meterKey_idempotencyKey_key" ON "billing"."usage_authorization"("grantId", "meterKey", "idempotencyKey");
CREATE INDEX "usage_authorization_status_expiresAt_idx" ON "billing"."usage_authorization"("status", "expiresAt");
CREATE INDEX "usage_authorization_tenantId_idx" ON "billing"."usage_authorization"("tenantId");

ALTER TABLE "billing"."usage_authorization" ADD CONSTRAINT "usage_authorization_grantId_meterKey_fkey" FOREIGN KEY ("grantId", "meterKey") REFERENCES "entitlement"."grant_meter"("grantId", "meterKey") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER usage_authorization_same_tenant BEFORE INSERT ON "billing"."usage_authorization"
  FOR EACH ROW EXECUTE FUNCTION entitlement.same_tenant();

ALTER TABLE billing.usage_authorization ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.usage_authorization FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON "billing"."usage_authorization" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "billing"."usage_authorization"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "billing"."usage_authorization"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
