-- A payment still verifying a day after it was made is flagged for a person
-- (F-092-y, ADR-0044 decision 5). Set once by reconciliation; never cleared.

ALTER TABLE "billing"."payment_transaction" ADD COLUMN "verifyFlaggedAt" TIMESTAMP(3);
