-- F-111-q — a Grant sold with unlimited traffic carries the fact as a flag.
--
-- The catalog is the only place `traffic_bytes.limit = 0` means unlimited
-- (catalog invariant 10). Downstream 0 means empty: the allocator splits a bag
-- of `purchasedBytes`, and exhaustion is `consumedBytes >= purchasedBytes`. So
-- a sold 0 is copied at issue as `trafficUnlimited`, and the bag stays 0.
--
-- Only a prepaid Grant can be unlimited (a metered one buys blocks, and a
-- block is a limit), and only with an empty bag — bytes bought for a Grant
-- that needs none would be a second, contradictory answer to what it carries.
--
-- Additive, defaulted false: every Grant issued before this was issued from a
-- limit (F-111-p refused 0 at sale). Rollback: drop the constraint and column.

ALTER TABLE "entitlement"."grant" ADD COLUMN "trafficUnlimited" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "entitlement"."grant" ADD CONSTRAINT "grant_traffic_unlimited_is_prepaid"
  CHECK (NOT "trafficUnlimited" OR ("billingMode" = 'prepaid' AND "purchasedBytes" = 0));
