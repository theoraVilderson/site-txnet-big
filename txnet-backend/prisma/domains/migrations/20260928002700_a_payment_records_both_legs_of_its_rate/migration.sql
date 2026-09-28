-- F-116-e (ADR-0098 parts 2, 6): a deposit is priced from the payment's
-- currency to the gateway's charge currency, `rate(to) / rate(from)` through
-- the USD pivot, one `currency_exchange_rate` row per leg. The existing
-- `exchangeRateSnapshotId` is the charge currency's leg (what it always was:
-- USD -> IRR); this column is the payment currency's. A leg on the pivot has no
-- row, so either may be NULL; both are NULL on a `staticRate` price, a gateway
-- charging the payment's own currency, and the free path.
--
-- A real foreign key, ON DELETE RESTRICT, for the reason the first one is
-- (20260912000100): evidence that can dangle is not evidence. No index, for the
-- same reason as that one.
--
-- `exchangeRateSnapshot` widens from DECIMAL(18,8) to DECIMAL(30,18). An
-- inverse pair (IRR -> USD is ~0.00000095) keeps one or two digits at 8 places,
-- and `creditForReceipt` / `followOnCredit` divide by the stored rate: the
-- pricer rounds the rate to 18 places before it charges, so the rate stored is
-- the rate charged. Widening keeps every existing value exactly (12 integer
-- digits where there were 10); nothing is rejected or rewritten in meaning.
--
-- Rollback: ALTER TABLE "billing"."payment_transaction"
--   DROP CONSTRAINT "payment_transaction_exchangeRateFromSnapshotId_fkey",
--   DROP COLUMN "exchangeRateFromSnapshotId",
--   ALTER COLUMN "exchangeRateSnapshot" TYPE DECIMAL(18,8);
-- (the narrowing rounds any rate written with more than 8 places)

-- AlterTable
ALTER TABLE "billing"."payment_transaction"
  ADD COLUMN "exchangeRateFromSnapshotId" UUID,
  ALTER COLUMN "exchangeRateSnapshot" SET DATA TYPE DECIMAL(30,18);

-- AddForeignKey
ALTER TABLE "billing"."payment_transaction"
  ADD CONSTRAINT "payment_transaction_exchangeRateFromSnapshotId_fkey"
  FOREIGN KEY ("exchangeRateFromSnapshotId")
  REFERENCES "currency"."currency_exchange_rate"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
