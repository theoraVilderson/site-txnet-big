-- F-601-i: a paid Grant still `pending` 5 minutes after purchase is announced
-- once — the buyer that it is being prepared, the tenant's owner why.
-- `deliveryDelayedAt` is the check that announced it; set conditionally on
-- null, so a later check, or two racing, announce nothing more. Existing
-- Grants start unset: a pending one past 5 minutes is told at its next check.
-- No index: it is read only on the Grant row a delivery check already holds.
--
-- Additive; rollback: drop the column, nothing else reads it.

ALTER TABLE "entitlement"."grant"
  ADD COLUMN "deliveryDelayedAt" TIMESTAMP(3);
