-- F-805-a: a person may send a payer's proof back once (`reject` with
-- `resubmit`); this is when it was, and so whether it was. Additive: no row
-- carries a proof yet, and a NULL is "never returned".
ALTER TABLE "billing"."payment_transfer_detail" ADD COLUMN "proofReturnedAt" TIMESTAMP(3);
