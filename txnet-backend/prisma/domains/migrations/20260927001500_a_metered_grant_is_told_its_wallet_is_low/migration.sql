-- F-601-g: a metered Grant is told once when its wallet buys under a GB at
-- its rate. `lowBalanceNoticeAt` is that crossing's instant (the notice's
-- period); the block purchase that sees the balance buy a GB again clears it.
-- Existing Grants start armed. No index: it is read only on the Grant row a
-- purchase already holds.
--
-- Additive; rollback: drop the column, nothing else reads it.

ALTER TABLE "entitlement"."grant"
  ADD COLUMN "lowBalanceNoticeAt" TIMESTAMP(3);
