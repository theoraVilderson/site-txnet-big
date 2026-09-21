-- F-027-b — a Config carries its desired state, its drift verdict and its
-- ceiling (ADR-0072, ADR-0074, ADR-0075).
--
-- F-027-a gave the Panel its declaration: how it counts, how it is reached.
-- This is the other side of the same conversation — what each client on it is
-- *supposed* to be, so the convergence loop has something to converge on.
--
-- 1. `remoteId`, `claimTag` and the existing `uuid` are the three matching
--    keys, tried in that order (F-027-aa). The tag is what we write on every
--    client we create: without it a rename on the panel orphans the usage and
--    we cut off a user whose config still works.
-- 2. `desiredEnabled` and `desiredRemote` are desired state, never queued
--    commands. ADR-0075 suspends first and purges later, and the loop always
--    compares the desired state as it is now — which is what makes a top-up
--    arriving mid-purge rebuild the client instead of racing the delete.
-- 3. `enforcementState` has to express `partial`: a purge half-applied across
--    five panels is neither pending nor done, and a Grant reports `purged`
--    only once every one of its configs is `complete`.
-- 4. `allocatedCeilingBytes` and `appliedCeilingBytes` are deliberately two
--    columns (ADR-0072). The first is what the allocator decided; the second
--    is what the panel confirmed. The gap between them is the loop's
--    remaining work and what the panel shows as `in queue`. Collapsed into
--    one, the system believes a ceiling it never managed to write — which is
--    free traffic at the far end of it, with nothing red anywhere.
-- 5. `observedRateBps` is what sizes the horizon in seconds rather than bytes
--    (F-027-u); `maxLineRateBps` on the panel is the stand-in until a rate has
--    been observed.
-- 6. `credentialGroupId` groups the configs issued together from one package
--    over one shared quota (§4.6).
--
-- Additive: every column is nullable or defaulted, and `network.config` has
-- never been written — no service reads or writes this schema (`source: []`).
-- The two unique indexes validate whatever rows are there rather than
-- assuming none; over an empty table that costs nothing.
--
-- Rollback: drop the constraints, the four indexes and the columns this file
-- adds, then drop the three types. Nothing outside
-- `network.config` refers to them.

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
CREATE TYPE "network"."DesiredRemote" AS ENUM ('present', 'absent');
CREATE TYPE "network"."EnforcementState" AS ENUM ('pending', 'partial', 'complete');
CREATE TYPE "network"."DriftState" AS ENUM ('synced', 'reset', 'renamed', 'rebuilt', 'missing', 'orphan', 'limit_overridden', 'contested');

-- -----------------------------------------------------------------------------
-- The desired state
-- -----------------------------------------------------------------------------
ALTER TABLE "network"."config"
    ADD COLUMN "remoteId" TEXT,
    ADD COLUMN "claimTag" TEXT,
    ADD COLUMN "credentialGroupId" UUID,
    ADD COLUMN "desiredEnabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "desiredRemote" "network"."DesiredRemote" NOT NULL DEFAULT 'present',
    ADD COLUMN "enforcementState" "network"."EnforcementState" NOT NULL DEFAULT 'pending',
    ADD COLUMN "driftState" "network"."DriftState" NOT NULL DEFAULT 'synced',
    ADD COLUMN "driftRepairCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastReconciledAt" TIMESTAMP(3),
    ADD COLUMN "allocatedCeilingBytes" BIGINT,
    ADD COLUMN "appliedCeilingBytes" BIGINT,
    ADD COLUMN "observedRateBps" BIGINT,
    ADD COLUMN "ceilingAppliedAt" TIMESTAMP(3);

-- A claim tag is ours and global, like `uuid`: the whole point of it is that a
-- client found under a changed name is still identifiably this row's.
CREATE UNIQUE INDEX "config_claimTag_key" ON "network"."config"("claimTag");

-- One remote client belongs to one config. NULLs stay distinct in Postgres, so
-- this constrains only the configs that have been created on a panel.
CREATE UNIQUE INDEX "config_panel_remote_id_key" ON "network"."config"("panelId", "remoteId");

-- The convergence loop's own scan: everything on one panel that is not yet
-- `complete`.
CREATE INDEX "config_panelId_enforcementState_idx" ON "network"."config"("panelId", "enforcementState");
CREATE INDEX "config_credentialGroupId_idx" ON "network"."config"("credentialGroupId");

-- -----------------------------------------------------------------------------
-- What the database refuses to hold
-- -----------------------------------------------------------------------------
ALTER TABLE "network"."config"
    -- A counter going backward is a reset, never negative usage (ADR-0074);
    -- the same holds for everything derived from one. A negative ceiling would
    -- be written to a panel as a limit no traffic can fit under.
    ADD CONSTRAINT "config_ceiling_bytes_not_negative" CHECK (
        ("allocatedCeilingBytes" IS NULL OR "allocatedCeilingBytes" >= 0)
        AND ("appliedCeilingBytes" IS NULL OR "appliedCeilingBytes" >= 0)),
    ADD CONSTRAINT "config_observed_rate_not_negative" CHECK ("observedRateBps" IS NULL OR "observedRateBps" >= 0),
    ADD CONSTRAINT "config_drift_repairs_not_negative" CHECK ("driftRepairCount" >= 0),
    -- The clock on the write, exactly as `blockedSince` is the clock on a ban.
    -- An applied ceiling with no timestamp cannot be aged out, so a stale one
    -- is indistinguishable from a fresh one.
    ADD CONSTRAINT "config_applied_ceiling_needs_time" CHECK (("appliedCeilingBytes" IS NOT NULL) = ("ceilingAppliedAt" IS NOT NULL)),
    -- ADR-0075: our rows are never deleted, `remoteId` is. A completed purge
    -- still holding one would have the loop adopt a seat it had just freed.
    ADD CONSTRAINT "config_purged_has_no_remote_id" CHECK (
        NOT ("desiredRemote" = 'absent' AND "enforcementState" = 'complete' AND "remoteId" IS NOT NULL));
