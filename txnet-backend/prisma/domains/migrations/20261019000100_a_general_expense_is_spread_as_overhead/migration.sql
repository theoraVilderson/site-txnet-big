-- F-1001-t: a tenant's general expenses (equipment, ads, staff, domain, rent),
-- each spread over its months into analytics_cost_day as `overhead`.
-- Additive: an enum value, an enum, two tables.

ALTER TYPE "billing"."AnalyticsCostKind" ADD VALUE 'overhead';

CREATE TYPE "billing"."GeneralExpenseCategory" AS ENUM ('equipment', 'advertising', 'staff', 'domain', 'rent', 'other');

CREATE TABLE "billing"."general_expense" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "category" "billing"."GeneralExpenseCategory" NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "spentOn" DATE NOT NULL,
    "months" SMALLINT NOT NULL,
    "note" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "general_expense_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "general_expense_amount_above_zero" CHECK ("amount" > 0),
    CONSTRAINT "general_expense_months" CHECK ("months" BETWEEN 1 AND 60),
    CONSTRAINT "general_expense_note" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 200)
);
CREATE INDEX "general_expense_tenantId_createdAt_idx" ON "billing"."general_expense"("tenantId", "createdAt");
-- The rollup's read: the expenses whose months reach a window.
CREATE INDEX "general_expense_tenantId_spentOn_idx" ON "billing"."general_expense"("tenantId", "spentOn");

CREATE TABLE "billing"."general_expense_take_back" (
    "expenseId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "general_expense_take_back_pkey" PRIMARY KEY ("expenseId")
);
ALTER TABLE "billing"."general_expense_take_back" ADD CONSTRAINT "general_expense_take_back_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "billing"."general_expense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- History: an expense, and its take back, is never edited — a change is a new row.
CREATE FUNCTION billing.general_expense_is_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is history: add a row, never edit one', TG_TABLE_NAME;
END $$;
CREATE TRIGGER general_expense_is_history BEFORE UPDATE ON "billing"."general_expense"
  FOR EACH ROW EXECUTE FUNCTION billing.general_expense_is_history();
CREATE TRIGGER general_expense_take_back_is_history BEFORE UPDATE ON "billing"."general_expense_take_back"
  FOR EACH ROW EXECUTE FUNCTION billing.general_expense_is_history();

-- Its tenant's only; read and added, never updated or deleted by the app.
ALTER TABLE "billing"."general_expense" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."general_expense" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing"."general_expense"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "billing"."general_expense"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON "billing"."general_expense" TO txnet_app, txnet_cross_tenant;

ALTER TABLE "billing"."general_expense_take_back" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."general_expense_take_back" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing"."general_expense_take_back"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "billing"."general_expense_take_back"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON "billing"."general_expense_take_back" TO txnet_app, txnet_cross_tenant;
