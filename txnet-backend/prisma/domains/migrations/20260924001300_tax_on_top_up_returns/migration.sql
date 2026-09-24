-- Tax returns to the top-up (ADR-0076, F-104-ae), reversing
-- `20260911000100_no_tax_on_top_up` — but not to the shape it dropped. The
-- rate is a two-level setting, as `depositPresets` is: a gateway's own rate,
-- NULL = inherit, over the tenant's default on `deposit_setting`, NULL = no tax.
-- ADR-0038's rollback note (`NOT NULL DEFAULT 10`) would tax every gateway at
-- 10% and leave no way to inherit, so it is not what this does.
--
-- Additive only. Payments already recorded were charged under ADR-0038, with
-- no tax: they read `taxApplied = 0` and no rate, which is exactly true, and
-- nothing is backfilled. The payment's own rate is frozen at intent, so a
-- later rate change cannot re-explain an old receipt.
--
-- A rate is a percentage at (9, 4), the precision `percentageModifier` uses.
-- Rollback: drop the five columns; the CHECKs go with them.

-- AlterTable
ALTER TABLE "billing"."payment_gateway" ADD COLUMN "taxRatePercent" DECIMAL(9,4),
  ADD CONSTRAINT "payment_gateway_taxRatePercent_range"
  CHECK ("taxRatePercent" IS NULL OR ("taxRatePercent" >= 0 AND "taxRatePercent" <= 100));

-- AlterTable
ALTER TABLE "tenant"."tenant_gateway_config" ADD COLUMN "taxRatePercent" DECIMAL(9,4),
  ADD CONSTRAINT "tenant_gateway_config_taxRatePercent_range"
  CHECK ("taxRatePercent" IS NULL OR ("taxRatePercent" >= 0 AND "taxRatePercent" <= 100));

-- AlterTable
ALTER TABLE "billing"."deposit_setting" ADD COLUMN "taxRatePercent" DECIMAL(9,4),
  ADD CONSTRAINT "deposit_setting_taxRatePercent_range"
  CHECK ("taxRatePercent" IS NULL OR ("taxRatePercent" >= 0 AND "taxRatePercent" <= 100));

-- AlterTable
ALTER TABLE "billing"."payment_transaction" ADD COLUMN "taxApplied" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "taxRatePercent" DECIMAL(9,4),
  ADD CONSTRAINT "payment_transaction_taxRatePercent_range"
  CHECK ("taxRatePercent" IS NULL OR ("taxRatePercent" >= 0 AND "taxRatePercent" <= 100)),
  ADD CONSTRAINT "payment_transaction_taxApplied_nonnegative"
  CHECK ("taxApplied" >= 0),
  ADD CONSTRAINT "payment_transaction_taxApplied_needs_rate"
  CHECK ("taxRatePercent" IS NOT NULL OR "taxApplied" = 0);
