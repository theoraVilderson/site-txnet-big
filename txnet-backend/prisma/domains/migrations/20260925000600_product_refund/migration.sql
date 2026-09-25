-- F-111-d: a paid invoice whose Grant could not be delivered is refunded in
-- full (spec §5.8 step 3). Its own wallet reason, so the credit shows on the
-- user's history as what it is and a reseller's sales come down by it
-- (`UNDOES` in `reseller-revenue.service.ts`); and its own invoice status, so a
-- refunded invoice is never read as a sale that stood.
--
-- Rollback: Postgres cannot drop one enum value; the rollback is to stop
-- writing them. Rows already written keep their values.

ALTER TYPE "billing"."WalletReasonType" ADD VALUE 'product_refund';
ALTER TYPE "billing"."InvoiceStatus" ADD VALUE 'refunded';
