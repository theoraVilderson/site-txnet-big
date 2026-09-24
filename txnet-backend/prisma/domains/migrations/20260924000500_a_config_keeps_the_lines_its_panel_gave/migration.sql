-- F-027-bj — a config keeps the link lines its panel gave it.
--
-- `/sub` renders stored lines and never contacts a panel (ADR-0082 rule 2).
-- The provisioning pass reads a client's lines on the read that confirms it,
-- and stores them with the client they came from: `linksRemoteId` and
-- `linksUuid`. A regenerate, a move, a rename or a rebuild confirms a client
-- that key does not match, and the lines are read again.
--
-- Empty `linkLines` with `linksCapturedAt` set is a panel that gives none, a
-- fact `/sub` shows; with it null the client was never captured. The CHECK
-- holds the key and the time together, and lines only with both.
--
-- Additive, nothing to backfill: a row with no capture is read on the next
-- pass that confirms its client. Rollback: drop the constraint and the columns.

ALTER TABLE "network"."config"
    ADD COLUMN "linkLines"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "linksRemoteId"   TEXT,
    ADD COLUMN "linksUuid"       TEXT,
    ADD COLUMN "linksCapturedAt" TIMESTAMP(3);

ALTER TABLE "network"."config"
    ADD CONSTRAINT "config_links_captured_from_a_client"
    CHECK (
        ("linksCapturedAt" IS NOT NULL AND "linksRemoteId" IS NOT NULL AND "linksUuid" IS NOT NULL)
        OR ("linksCapturedAt" IS NULL AND "linksRemoteId" IS NULL AND "linksUuid" IS NULL
            AND cardinality("linkLines") = 0)
    );
