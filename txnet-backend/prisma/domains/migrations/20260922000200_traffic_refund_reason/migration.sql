-- F-027-r: the remainder of a closed Grant's purchased bytes is credited back
-- (ADR-0072 rule 3), and it is its own reason.
--
-- It is not a `traffic_consumption` row wearing the other direction: that value
-- is the one `/wallet/history` leaves out of a page nobody narrowed (F-027-am),
-- so money coming *back* would be hidden from the person it went back to. A new
-- value joins the default page by the rule in `contract.history.md` — the
-- filter names the other types, never a `notIn`.
--
-- Rollback: Postgres cannot drop one enum value; the rollback is to stop
-- writing it. Rows already written keep their reason.

ALTER TYPE "billing"."WalletReasonType" ADD VALUE 'traffic_refund';
