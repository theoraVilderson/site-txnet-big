-- F-111-o — a config remembers the first time its panel confirmed it.
--
-- `network.config.confirmed` (F-111-n) activates a pending Grant the moment
-- its panel is read holding the client. Announced on every partial -> complete,
-- it also fired on each disable, rotation and repair — a mass expiry would be
-- thousands of calls to billing with nothing to activate. `network-service`
-- reads only `network.*` (ADR-0071), so it cannot ask whether the Grant is
-- still pending; it can know whether this is the config's first confirmation.
--
-- Backfill: a present config already `complete` was confirmed, and is given
-- its last reconciliation as the time, so it does not announce on its next
-- re-confirmation. Additive and nullable. Rollback: drop the column.

ALTER TABLE "network"."config" ADD COLUMN "confirmedAt" TIMESTAMP(3);

UPDATE "network"."config"
   SET "confirmedAt" = COALESCE("lastReconciledAt", "createdAt")
 WHERE "enforcementState" = 'complete' AND "desiredRemote" = 'present';
