-- F-038-i (ADR-0109 point 13): a suggestion's conversion — the purchase or
-- top-up it suggested, within 7 days — recorded on the row, a holdout row's
-- too, so the uplift report reads both arms from `ai.action` alone.
-- `outcomeAt` keeps its meaning (when a status ended: expired, dismissed).
--
-- Additive. Rollback: DROP INDEX ai."action_tenantId_createdAt_idx";
-- ALTER TABLE ai.action DROP CONSTRAINT action_conversion_has_currency,
--   DROP CONSTRAINT action_conversion_has_time,
--   DROP COLUMN "convertedAt", DROP COLUMN "convertedAmount", DROP COLUMN "convertedCurrency";

ALTER TABLE "ai"."action"
  ADD COLUMN "convertedAt" TIMESTAMP(3),
  ADD COLUMN "convertedAmount" DECIMAL(18,2),
  ADD COLUMN "convertedCurrency" TEXT;

ALTER TABLE "ai"."action" ADD CONSTRAINT "action_conversion_has_currency"
  CHECK (("convertedAmount" IS NULL) = ("convertedCurrency" IS NULL));
ALTER TABLE "ai"."action" ADD CONSTRAINT "action_conversion_has_time"
  CHECK ("convertedAmount" IS NULL OR "convertedAt" IS NOT NULL);

-- The report reads one tenant's rows by when they were decided.
CREATE INDEX "action_tenantId_createdAt_idx" ON "ai"."action"("tenantId", "createdAt");
