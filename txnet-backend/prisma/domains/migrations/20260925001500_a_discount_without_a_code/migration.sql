-- F-114-h (D-45, ADR-0087): a discount with no code. A rule is one tenant's
-- own, taken at invoice pricing from every purchase it matches, before any
-- coupon; the invoice records which rule and what it took. A campaign price
-- (F-503) is not this: that is a new catalog price row, never a rule.
--
-- What it covers is everything, one product, or one category and those under
-- it (at most one of the two columns); who it serves is everyone, or the rows
-- of `discount_rule_user`. Which rule wins when several match is code
-- (`bestDiscountRule`), not a constraint.

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'discount_rule_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'discount_rule_update';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'discount_rule';

-- CreateEnum
CREATE TYPE "billing"."DiscountRuleKind" AS ENUM ('percentage', 'fixed_amount');

-- CreateTable
CREATE TABLE "billing"."discount_rule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "kind" "billing"."DiscountRuleKind" NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "productId" UUID,
    "categoryId" UUID,
    "forNamedUsers" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByAdminId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "discount_rule_value_ok" CHECK (
        ("kind" = 'percentage' AND "value" > 0 AND "value" <= 100)
        OR ("kind" = 'fixed_amount' AND "value" > 0)
    ),
    CONSTRAINT "discount_rule_one_target" CHECK ("productId" IS NULL OR "categoryId" IS NULL),
    CONSTRAINT "discount_rule_window_ok" CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt")
);

-- CreateTable
CREATE TABLE "billing"."discount_rule_user" (
    "ruleId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,

    CONSTRAINT "discount_rule_user_pkey" PRIMARY KEY ("ruleId", "userId")
);

-- CreateIndex
CREATE INDEX "discount_rule_tenantId_isActive_idx" ON "billing"."discount_rule"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "discount_rule_user_userId_idx" ON "billing"."discount_rule_user"("userId");

-- AddForeignKey
ALTER TABLE "billing"."discount_rule" ADD CONSTRAINT "discount_rule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "catalog"."product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."discount_rule" ADD CONSTRAINT "discount_rule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "catalog"."product_category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."discount_rule_user" ADD CONSTRAINT "discount_rule_user_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "billing"."discount_rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The invoice names the rule it took and what the rule took; `discount` stays
-- the whole, so `total = amount - discount` holds as before.
ALTER TABLE "billing"."invoice" ADD COLUMN "discountRuleId" UUID,
ADD COLUMN "ruleDiscount" DECIMAL(18,2) NOT NULL DEFAULT 0;

ALTER TABLE "billing"."invoice" ADD CONSTRAINT "invoice_rule_discount_within_discount"
    CHECK ("ruleDiscount" >= 0 AND "ruleDiscount" <= "discount");
ALTER TABLE "billing"."invoice" ADD CONSTRAINT "invoice_rule_discount_names_rule"
    CHECK ("ruleDiscount" = 0 OR "discountRuleId" IS NOT NULL);

-- AddForeignKey
ALTER TABLE "billing"."invoice" ADD CONSTRAINT "invoice_discountRuleId_fkey" FOREIGN KEY ("discountRuleId") REFERENCES "billing"."discount_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Strict shape (`20260909001500_row_level_security_all_tables`, shape A): every
-- row is exactly one tenant's, the platform owner's rules included.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing.discount_rule',
    'billing.discount_rule_user'
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
