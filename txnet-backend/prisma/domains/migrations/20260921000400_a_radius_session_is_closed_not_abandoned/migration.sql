-- F-027-d — the RADIUS session, the one table a push source needs and a pull
-- source does not (ADR-0074).
--
-- F-027-c gave the pipeline the six tables a measured byte waits in. Those are
-- written from a *total*: a pull panel hands us a running figure and
-- `config_counter_state` remembers where the counter was. A NAS hands us
-- accounting packets about a session instead, and the session is the unit of
-- everything that can go wrong with one:
--
-- 1. `Acct-Input-Octets` is 32 bits and wraps at 4 GB, with the high bits in
--    `Acct-Input-Gigawords`. A NAS that omits Gigawords loses 4 GB per wrap in
--    silence, and the loss is indistinguishable from a quiet user unless we
--    recorded whether the attribute was ever there — so `gigawordsSeen` is
--    what turns bytes past the wrap into a `gigawords_missing` hold rather
--    than a guess. Every byte column here is BIGINT for the same reason: the
--    reconstructed total in 32 bits would be the same trap in our own storage.
-- 2. A session counter only rises, so what is stored is a high water mark. A
--    lower reading is a NAS restart, never negative usage.
-- 3. A session whose `Stop` never arrives closes at its last observed figure
--    and is never extrapolated past it. `publishedInBytes` /
--    `publishedOutBytes` are bounded by the mark so that extrapolation cannot
--    be written down, and `closeReason` says which of the five ways a session
--    ended — only `acct_stop` is the NAS telling us, and the other four are us
--    deciding, which is a materially weaker figure.
--
-- The identity is `(nasId, acctSessionId)`: `Acct-Session-Id` is unique only
-- within the NAS that issued it, so two NASes numbering from 1 would otherwise
-- collide and one user's traffic would land on another's session.
--
-- The table lands now, ahead of the receiver (F-027-af), so that one migration
-- series covers the whole network schema.
--
-- Purely additive: one new table and one new type. Nothing existing is
-- altered, and no service reads or writes this schema yet (`source: []`).
--
-- Rollback: drop the table, then the type. Nothing outside them refers to
-- either.

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------
CREATE TYPE "network"."RadiusSessionCloseReason" AS ENUM ('acct_stop', 'stale_timeout', 'nas_restart', 'superseded', 'administrative');

-- -----------------------------------------------------------------------------
-- The session
-- -----------------------------------------------------------------------------
CREATE TABLE "network"."radius_session" (
    "id" UUID NOT NULL,
    "panelId" UUID NOT NULL,
    "nasId" TEXT NOT NULL,
    "acctSessionId" TEXT NOT NULL,
    "configId" UUID,
    "remoteIdentifier" TEXT NOT NULL,
    "highWaterInBytes" BIGINT NOT NULL DEFAULT 0,
    "highWaterOutBytes" BIGINT NOT NULL DEFAULT 0,
    "publishedInBytes" BIGINT NOT NULL DEFAULT 0,
    "publishedOutBytes" BIGINT NOT NULL DEFAULT 0,
    "gigawordsSeen" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closeReason" "network"."RadiusSessionCloseReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "radius_session_pkey" PRIMARY KEY ("id")
);

-- The session id is the NAS's, not ours, and it is unique only within that
-- NAS. The pair is the identity.
CREATE UNIQUE INDEX "radius_session_nas_acct_key" ON "network"."radius_session"("nasId", "acctSessionId");
-- The stale sweep: open sessions last seen before a cutoff.
CREATE INDEX "radius_session_closedAt_lastSeenAt_idx" ON "network"."radius_session"("closedAt", "lastSeenAt");
-- Attribution, and one config's session history.
CREATE INDEX "radius_session_configId_idx" ON "network"."radius_session"("configId");

ALTER TABLE "network"."radius_session"
    ADD CONSTRAINT "radius_session_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "network"."panel"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "radius_session_configId_fkey" FOREIGN KEY ("configId") REFERENCES "network"."config"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- A reading below the high water mark is a NAS restart, never negative
    -- usage (ADR-0074).
    ADD CONSTRAINT "radius_session_bytes_not_negative" CHECK (
        "highWaterInBytes" >= 0 AND "highWaterOutBytes" >= 0
        AND "publishedInBytes" >= 0 AND "publishedOutBytes" >= 0),
    -- A session with no `Stop` closes at its last observed figure and is never
    -- extrapolated past it. Published above measured *is* that extrapolation,
    -- and it reaches the user as a charge for traffic nobody watched happen.
    ADD CONSTRAINT "radius_session_published_within_high_water" CHECK (
        "publishedInBytes" <= "highWaterInBytes"
        AND "publishedOutBytes" <= "highWaterOutBytes"),
    -- Open is the absence of both. A close time with no reason cannot be told
    -- apart from a real `Stop`, which is where a stale session's last figure
    -- quietly becomes a final one.
    ADD CONSTRAINT "radius_session_closed_has_reason" CHECK (
        ("closedAt" IS NOT NULL) = ("closeReason" IS NOT NULL));
