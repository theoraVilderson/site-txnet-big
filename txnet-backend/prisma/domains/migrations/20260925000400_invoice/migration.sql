-- =============================================================================
-- F-111-a — an invoice for one catalog variant (spec §5.8 step 1)
-- =============================================================================
-- The server prices it from the catalog in USD when it is created; `priceId` is
-- the price row that was in effect, so what it costs can always be explained.
-- Its coupon holds are the `coupon_redemption` rows whose `orderReferenceId`
-- is the invoice's id (F-092-h). Paying it is F-111-b; a `pending` one past
-- `expiresAt` is expired by the `invoice_pending_expiry` sweep.
--
-- The variant and the price are RESTRICT, like a Grant's: a variant anyone was
-- invoiced for is archived, never deleted (F-026-h — the foreign keys decide).

-- CreateEnum
CREATE TYPE "billing"."InvoiceStatus" AS ENUM ('pending', 'paid', 'expired', 'cancelled');

-- CreateTable
CREATE TABLE "billing"."invoice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "priceId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "discount" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "status" "billing"."InvoiceStatus" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id"),
    -- A price may be zero (a free variant); a discount never takes it below zero.
    CONSTRAINT "invoice_amount_not_negative" CHECK ("amount" >= 0),
    CONSTRAINT "invoice_discount_within_amount" CHECK ("discount" >= 0 AND "discount" <= "amount"),
    CONSTRAINT "invoice_total_is_amount_less_discount" CHECK ("total" = "amount" - "discount")
);

-- CreateIndex
CREATE INDEX "invoice_status_expiresAt_idx" ON "billing"."invoice"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "invoice_tenantId_userId_createdAt_idx" ON "billing"."invoice"("tenantId", "userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "invoice_variantId_idx" ON "billing"."invoice"("variantId");

-- AddForeignKey
ALTER TABLE "billing"."invoice" ADD CONSTRAINT "invoice_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "catalog"."product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."invoice" ADD CONSTRAINT "invoice_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "catalog"."price"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Strict shape (`20260909001500_row_level_security_all_tables`, shape A): every
-- row is exactly one tenant's. The cross-tenant pool reads it for the expiry
-- sweep's scan alone; every write runs in the invoice's own tenant.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing.invoice'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);

    EXECUTE format('DROP POLICY IF EXISTS cross_tenant ON %s', t);
    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);
  END LOOP;
END
$$;
