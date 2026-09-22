-- F-027-al — a metered rate of zero is refused where the price is written.
--
-- `20260921000700` allowed zero, reading it as "metered but not charged for —
-- a trial, an internal account". F-027-q then built the other end and that
-- reading did not survive it: `sizeBlock` refuses a rate of zero outright
-- (`rate_not_priceable`), because a block of bytes with a price of zero cents
-- is not a block anyone can buy — the purchaser has nothing to debit and the
-- byte cursor nothing to advance against. So a variant priced at nothing does
-- not serve free traffic; it stalls its user at the first block, hours and one
-- service away from whoever typed the price.
--
-- Free metered service is a quota with no rate, or a prepaid variant — not a
-- rate of zero. This moves the refusal to the act that caused it.
--
-- `GrantService.issue` refuses the same value (`metered_rate_not_positive`) so
-- an admin writing a rate through the application hears it in the same call;
-- the CHECK is what holds for anything that reaches the table another way.
--
-- Additive in effect: nothing writes `metered_rate` yet (F-027-g created it,
-- F-027-p only reads it), so the constraint swap has no rows to validate. If
-- it ever does, a zero row fails the migration loudly rather than being
-- rewritten under an operator who did not choose the new price.
-- Rollback: drop `metered_rate_is_positive`, restore `metered_rate_not_negative`.

ALTER TABLE "catalog"."metered_rate" DROP CONSTRAINT "metered_rate_not_negative";

ALTER TABLE "catalog"."metered_rate" ADD CONSTRAINT "metered_rate_is_positive" CHECK ("rate" > 0);
