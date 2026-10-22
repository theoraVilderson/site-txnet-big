-- F-305-c (ADR-0158, billing contract.renewal.md): an invoice may renew a Grant
-- the buyer holds instead of selling a new one.
--
-- 1. `grantId` names the Grant; `renewBytes` and `renewDays` are what the plan
--    added when it was quoted, so paying adds what was priced even if the
--    variant is edited in between (rule 9).
-- 2. All three or none (`invoice_renewal_whole`), and a renewal adds something.
-- 3. A Grant is never deleted (it is closed, with history behind it), so the
--    key is RESTRICT, as `grant_renewal`'s is.
-- Additive: three nullable columns; every invoice so far is a purchase.
-- Rollback: drop the constraint, the index and the three columns.

ALTER TABLE "billing"."invoice"
  ADD COLUMN "grantId" UUID,
  ADD COLUMN "renewBytes" BIGINT,
  ADD COLUMN "renewDays" INTEGER;

ALTER TABLE "billing"."invoice" ADD CONSTRAINT "invoice_renewal_whole" CHECK (
  ("grantId" IS NULL AND "renewBytes" IS NULL AND "renewDays" IS NULL)
  OR ("grantId" IS NOT NULL AND "renewBytes" >= 0 AND "renewDays" >= 0 AND ("renewBytes" > 0 OR "renewDays" > 0))
);

CREATE INDEX "invoice_grantId_idx" ON "billing"."invoice"("grantId");

ALTER TABLE "billing"."invoice" ADD CONSTRAINT "invoice_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "entitlement"."grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
