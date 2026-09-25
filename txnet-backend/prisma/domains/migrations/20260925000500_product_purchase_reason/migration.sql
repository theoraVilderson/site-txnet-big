-- F-111-b: paying an invoice from the wallet (spec §5.8 step 2) debits it
-- under its own reason, `referenceId` = the invoice.
--
-- Not `reseller_purchase` (a reseller package, the platform's revenue) and not
-- `traffic_consumption` (the value `/wallet/history` leaves out of a page
-- nobody narrowed, F-027-am): a product bought is money the user must see go,
-- and a sale the reseller made.
--
-- Rollback: Postgres cannot drop one enum value; the rollback is to stop
-- writing it. Rows already written keep their reason.

ALTER TYPE "billing"."WalletReasonType" ADD VALUE 'product_purchase';
