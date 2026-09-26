-- F-111-r — a config of an unlimited Grant carries the fact itself.
--
-- network-service reads `network.config` and nothing of entitlement, so the
-- Grant's `trafficUnlimited` (F-111-q) is copied onto each config when it is
-- made. The Grant's flag is set at issue and never changes, so the copy cannot
-- go stale. Provisioning creates such a client with no limit rather than wait
-- for an allocation that, by construction, never comes.
--
-- The CHECK is what keeps the ceiling pass and the shutdown extension away
-- from it: both read only rows with a ceiling, and an unlimited config never
-- holds one — a number there would be a limit on what was sold as none.
--
-- Additive. Rows of an unlimited Grant made before this are backfilled (none
-- exist on dev). Rollback: drop the constraint and the column.

ALTER TABLE "network"."config" ADD COLUMN "trafficUnlimited" BOOLEAN NOT NULL DEFAULT false;

UPDATE "network"."config" c
   SET "trafficUnlimited" = true, "allocatedCeilingBytes" = NULL, "walletBackedCeilingBytes" = NULL
  FROM "entitlement"."grant" g
 WHERE g.id = c."grantId" AND g."trafficUnlimited";

ALTER TABLE "network"."config" ADD CONSTRAINT "config_unlimited_has_no_ceiling"
  CHECK (NOT "trafficUnlimited" OR ("allocatedCeilingBytes" IS NULL AND "walletBackedCeilingBytes" IS NULL));
