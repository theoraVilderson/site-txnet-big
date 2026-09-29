-- F-118-i (D-58, ADR-0105 decision 9): a spending cap on one product.
--
-- 1. `billing.spending_cap`: one per Grant. The owner labels who the Grant is
--    for and caps what its usage may cost, in the wallet's currency, over the
--    Grant's life (`none`) or per month from the cap's own start date
--    (`monthly`). Billing funds the Grant to `min(free balance, amount −
--    spent − held for it)`; `spent` is advanced by every usage charge in the
--    transaction of that charge.
-- 2. Its Grant's tenant (`entitlement.same_tenant()`), strictly tenant-scoped
--    RLS, like `grant_meter`.
-- 3. `billing.sub_account` is dropped: a byte pocket on one config, 0 rows and
--    no writer (ADR-0105). The `sub_account_charge` ledger reason stays — an
--    enum value is not removable in place, and nothing writes it.
--
-- Rollback: DROP TABLE "billing"."spending_cap"; DROP TYPE
-- "billing"."SpendingCapPeriod"; recreate `sub_account` from
-- 20260908000000_init (empty).

DROP TABLE "billing"."sub_account";

CREATE TYPE "billing"."SpendingCapPeriod" AS ENUM ('none', 'monthly');

CREATE TABLE "billing"."spending_cap" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "period" "billing"."SpendingCapPeriod" NOT NULL DEFAULT 'none',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodStartsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "spent" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spending_cap_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "spending_cap_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "spending_cap_spent_non_negative" CHECK ("spent" >= 0),
    CONSTRAINT "spending_cap_label_shape" CHECK (length(btrim("label")) BETWEEN 1 AND 40),
    CONSTRAINT "spending_cap_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$'),
    CONSTRAINT "spending_cap_period_after_start" CHECK ("periodStartsAt" >= "startsAt")
);

CREATE UNIQUE INDEX "spending_cap_grantId_key" ON "billing"."spending_cap"("grantId");
CREATE INDEX "spending_cap_tenantId_idx" ON "billing"."spending_cap"("tenantId");

ALTER TABLE "billing"."spending_cap" ADD CONSTRAINT "spending_cap_grantId_fkey"
    FOREIGN KEY ("grantId") REFERENCES "entitlement"."grant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER spending_cap_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "grantId" ON "billing"."spending_cap"
  FOR EACH ROW EXECUTE FUNCTION entitlement.same_tenant();

ALTER TABLE billing.spending_cap ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.spending_cap FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."spending_cap" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "billing"."spending_cap"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "billing"."spending_cap"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
