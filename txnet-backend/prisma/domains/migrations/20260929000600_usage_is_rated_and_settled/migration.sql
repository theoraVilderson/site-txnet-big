-- F-118-g: rating and settlement of a Grant's meters (ADR-0105 (11)).
--
-- `usage_charge`: a metered Grant's usage paid for — a prepaid block debited
-- before it is served, or a postpaid hold captured. A sale. `usage_refund`: a
-- prepaid block's unused units given back at close; it undoes a
-- `usage_charge`. `referenceId` = the Grant for both. `traffic_consumption`
-- and `traffic_refund` stay for VPN's byte path until F-118-l.
--
-- Rollback: Postgres cannot drop one enum value; the rollback is to stop
-- writing them. Rows already written keep their reason.

ALTER TYPE "billing"."WalletReasonType" ADD VALUE 'usage_charge';
ALTER TYPE "billing"."WalletReasonType" ADD VALUE 'usage_refund';
