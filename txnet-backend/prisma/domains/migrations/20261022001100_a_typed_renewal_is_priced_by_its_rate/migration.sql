-- F-305-e (ADR-0158 (4)-(5), billing contract.renewal.md rules 5, 8, 9): a
-- renewal of GiB and days typed is priced by the product's renewal rate, not
-- by a variant's price row.
--
-- 1. `priceId` may be null; `renewalRateId` names the rate row a typed
--    renewal was priced at, so paying charges what was quoted.
-- 2. Exactly one of the two (`invoice_priced_once`), and a rate only on a
--    renewal (`grantId` set).
-- 3. A rate row is history, deleted only with its product, which an invoiced
--    variant already keeps (RESTRICT), so the key is RESTRICT too.
-- Expand only: every invoice so far has a `priceId`, so the CHECK holds for all
-- of them; no reader of `priceId` assumes it set (the one writer is
-- `InvoiceService.create`).
-- Rollback: delete typed-renewal invoices or give them a price, drop the
-- constraint, the index and the column, set `priceId` NOT NULL again.

ALTER TABLE "billing"."invoice" ALTER COLUMN "priceId" DROP NOT NULL;
ALTER TABLE "billing"."invoice" ADD COLUMN "renewalRateId" UUID;

ALTER TABLE "billing"."invoice" ADD CONSTRAINT "invoice_priced_once" CHECK (
  ("priceId" IS NULL) <> ("renewalRateId" IS NULL)
  AND ("renewalRateId" IS NULL OR "grantId" IS NOT NULL)
);

CREATE INDEX "invoice_renewalRateId_idx" ON "billing"."invoice"("renewalRateId");

ALTER TABLE "billing"."invoice" ADD CONSTRAINT "invoice_renewalRateId_fkey"
  FOREIGN KEY ("renewalRateId") REFERENCES "catalog"."renewal_rate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
