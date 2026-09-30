-- F-118-ac (D-59 (f)): an admin's byte gift on a reseller's metered Grant.
-- Platform staff's gift buys no wholesale and is never charged to the
-- reseller; its own staff's is bought at the gift.
--
-- `wholesaleGifted`: the bytes platform staff gifted. The gift raises
-- `wholesaleBilled` by the same figure at no charge, so the next block does
-- not buy it; at close the refund stops at `wholesaleConsumed` + this, so it
-- is never given back as money. 0 on every row so far.
--
-- `grant_bulk_job.byPlatform`: a filter job acts later, off the request; it
-- keeps whether its admin was admitted as platform staff. false so far.
--
-- Additive; rollback: DROP both columns.

ALTER TABLE "entitlement"."grant_meter" ADD COLUMN "wholesaleGifted" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "entitlement"."grant_meter" ADD CONSTRAINT "grant_meter_wholesale_gifted_within_billed"
  CHECK ("wholesaleGifted" >= 0 AND "wholesaleGifted" <= "wholesaleBilled");

ALTER TABLE "billing"."grant_bulk_job" ADD COLUMN "byPlatform" BOOLEAN NOT NULL DEFAULT false;
