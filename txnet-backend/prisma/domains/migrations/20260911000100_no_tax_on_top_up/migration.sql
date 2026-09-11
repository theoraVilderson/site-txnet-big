-- A top-up carries no tax (F-092-q, ADR-0038). Tax is charged when wallet
-- credit buys a service; a top-up is a prepayment. So the gateway tax rate and
-- the payment's tax amount go.
--
-- Destructive, and safe to be: the three tables have never been written. They
-- gained or kept these columns in `20260908000000_init` and
-- `20260911000000_payment_legacy_port`, and no service, job or seed reads or
-- sets them yet.
--
-- Rollback, while the tables are still empty: add each column back with the
-- type and default it had — `DECIMAL(5,2) NOT NULL DEFAULT 10` for both
-- `taxRatePercent`, `DECIMAL(18,2) NOT NULL DEFAULT 0` for `taxApplied`.

-- AlterTable
ALTER TABLE "billing"."payment_gateway" DROP COLUMN "taxRatePercent";

-- AlterTable
ALTER TABLE "billing"."payment_transaction" DROP COLUMN "taxApplied";

-- AlterTable
ALTER TABLE "tenant"."tenant_gateway_config" DROP COLUMN "taxRatePercent";
