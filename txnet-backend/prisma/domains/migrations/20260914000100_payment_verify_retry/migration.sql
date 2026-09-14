-- A verifying payment (F-092-x, ADR-0044 decision 1). Not a status: a pending
-- row whose nextVerifyAt is set is one the gateway met with silence, and the
-- ladder in billing-service verify-retry.ts says when to ask again.

ALTER TABLE "billing"."payment_transaction"
  ADD COLUMN "verifyAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextVerifyAt" TIMESTAMP(3);

-- Reconciliation's due-ness scan (F-092-y) reads pending rows by this column.
CREATE INDEX "payment_transaction_status_nextVerifyAt_idx"
  ON "billing"."payment_transaction" ("status", "nextVerifyAt");
