-- F-027-bj, contract.links.md rule 6b — an inbound edited on the panel
-- refreshes the lines read from it.
--
-- Reported 2026-10-06: an inbound edited on its panel kept every buyer's
-- `/sub` on the old lines until each config was regenerated. A capture was
-- keyed by the client alone (`linksRemoteId`, `linksUuid`), and an edit to the
-- inbound moves neither. The inventory read now stores a hash of what the
-- inbound's lines are built from, and the lines the one they were read under;
-- a difference is a refresh.
--
-- Additive. Null is "none known": a family that cannot fingerprint its
-- inbounds, or lines read before this. Rollback: drop both columns.

ALTER TABLE "network"."panel_inbound" ADD COLUMN "fingerprint" TEXT;

ALTER TABLE "network"."config" ADD COLUMN "linksInboundFingerprint" TEXT;
