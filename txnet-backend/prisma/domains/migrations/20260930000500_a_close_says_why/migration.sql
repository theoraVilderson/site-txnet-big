-- F-027-dz (user 2026-09-30): a close says why. `network.lease_close.reason`
-- is `spent` (Quota − Used ≤ 0), `ended` (the end passed) or `guard` (every
-- active replica blocked with bytes still paid). Billing suspends a prepaid
-- Grant only on `spent` or `ended`; a guard close reopens once it settles.
--
-- Backfill: a close taken on or past its end is `ended`; every other row is
-- `spent`, which is what billing already read it as — the planner rewrites
-- nothing it has not re-decided, so an existing guard close stays suspended
-- and a renewal revives it as before. No default: the planner names it.
--
-- Additive; rollback: DROP COLUMN "reason", DROP TYPE "LeaseCloseReason".

CREATE TYPE "network"."LeaseCloseReason" AS ENUM ('spent', 'ended', 'guard');

ALTER TABLE "network"."lease_close" ADD COLUMN "reason" "network"."LeaseCloseReason";
UPDATE "network"."lease_close"
   SET "reason" = CASE WHEN "expiresAt" IS NOT NULL AND "expiresAt" <= "closedAt" THEN 'ended' ELSE 'spent' END::"network"."LeaseCloseReason";
ALTER TABLE "network"."lease_close" ALTER COLUMN "reason" SET NOT NULL;
