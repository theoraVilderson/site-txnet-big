-- F-027-c — the six tables the usage pipeline keeps its state in (ADR-0074).
--
-- F-027-a gave the Panel its declaration and F-027-b gave the Config its
-- desired state. This is where the measured bytes themselves live between the
-- source and the ledger, and every table here exists to make one promise
-- mechanical: a measured byte is billed, held or quarantined — never silently
-- dropped.
--
-- 1. `config_counter_state` is the collector's memory of the raw counter. It
--    is what makes a counter going backward a *reset* rather than negative
--    usage, and it carries the `counterSemantics` the cursor was computed
--    under: a panel re-declared from `cumulative` to `session` invalidates it,
--    and a cursor that does not say what it meant cannot be invalidated.
--    `lastPublishedAt` is written only after a successful publish (F-027-n),
--    so a crash between read and publish re-reads rather than loses.
-- 2. `usage_delta_seen` makes the delta's own id the primary key. The insert
--    *is* the deduplication: a redelivered message is a constraint violation
--    the consumer absorbs, not a second charge. It is swept at 48h, which is
--    the only reason `seenAt` is indexed.
-- 3. `usage_delta_quarantine` holds a figure we do not believe, and
--    `usage_hold` holds one we believe but a declared incapacity stops us
--    billing (a NAS with no Gigawords, a session with no `Stop`). Both end
--    `released` or `written_off`; there is no `dropped`. The holds queue
--    (F-027-ad) is the visible face of this — while anything sits in it,
--    nobody can claim the system lost a byte in silence.
-- 4. `panel_drift_event` is the panel-wide stop (F-027-ab). A backup restore
--    reads as thousands of individually plausible resets, so the population is
--    the unit of judgement; `collectionHalted` defaults to true because
--    carrying on is ~$16k of wrong charges in a minute.
-- 5. `unattributed_usage` is the byte we measured and could not place. It has
--    a row precisely so it cannot be dropped, and one row per remote client
--    rather than per reading — an orphan is re-observed every pass.
--
-- Purely additive: six new tables and five new types. Nothing existing is
-- altered, and no service reads or writes this schema yet (`source: []`).
--
-- Rollback: drop the six tables, then the five types. Nothing outside them
-- refers to either.

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------
CREATE TYPE "network"."UsageDispositionState" AS ENUM ('pending', 'released', 'written_off');
CREATE TYPE "network"."HoldReason" AS ENUM ('gigawords_missing', 'session_never_closed', 'publish_failed_after_read', 'attribution_ambiguous', 'panel_drift_event', 'low_trust_source');
CREATE TYPE "network"."QuarantineReason" AS ENUM ('implausible_volume', 'implausible_rate', 'reset_with_unmeasured_bytes', 'semantics_mismatch', 'clock_went_backward', 'panel_drift_event');
CREATE TYPE "network"."PanelDriftEventType" AS ENUM ('mass_reset', 'mass_missing', 'mass_rename', 'mass_limit_override');
CREATE TYPE "network"."UnattributedUsageState" AS ENUM ('open', 'attributed', 'dismissed');

-- -----------------------------------------------------------------------------
-- The counter cursor
-- -----------------------------------------------------------------------------
CREATE TABLE "network"."config_counter_state" (
    "id" UUID NOT NULL,
    "configId" UUID NOT NULL,
    "panelId" UUID NOT NULL,
    "counterSemantics" "network"."CounterSemantics" NOT NULL,
    "lastUpBytes" BIGINT NOT NULL DEFAULT 0,
    "lastDownBytes" BIGINT NOT NULL DEFAULT 0,
    "lifetimeUpBytes" BIGINT NOT NULL DEFAULT 0,
    "lifetimeDownBytes" BIGINT NOT NULL DEFAULT 0,
    "lastObservedAt" TIMESTAMP(3),
    "lastPublishedAt" TIMESTAMP(3),
    "resetCount" INTEGER NOT NULL DEFAULT 0,
    "lastResetAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "config_counter_state_pkey" PRIMARY KEY ("id")
);

-- One cursor per config. Two of them is two opinions about where the counter
-- was, and the losing one re-counts everything since the last reset.
CREATE UNIQUE INDEX "config_counter_state_configId_key" ON "network"."config_counter_state"("configId");
CREATE INDEX "config_counter_state_panelId_idx" ON "network"."config_counter_state"("panelId");

ALTER TABLE "network"."config_counter_state"
    ADD CONSTRAINT "config_counter_state_configId_fkey" FOREIGN KEY ("configId") REFERENCES "network"."config"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- A counter going backward is a reset, never negative usage (ADR-0074).
    ADD CONSTRAINT "config_counter_state_bytes_not_negative" CHECK (
        "lastUpBytes" >= 0 AND "lastDownBytes" >= 0
        AND "lifetimeUpBytes" >= 0 AND "lifetimeDownBytes" >= 0),
    ADD CONSTRAINT "config_counter_state_resets_not_negative" CHECK ("resetCount" >= 0);

-- -----------------------------------------------------------------------------
-- The dedupe table
-- -----------------------------------------------------------------------------
CREATE TABLE "network"."usage_delta_seen" (
    "deltaId" UUID NOT NULL,
    "configId" UUID NOT NULL,
    "panelId" UUID NOT NULL,
    "upBytes" BIGINT NOT NULL,
    "downBytes" BIGINT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- The delta's own id is the key: applying a redelivered message is a
    -- primary-key violation, not a second charge (F-027-n).
    CONSTRAINT "usage_delta_seen_pkey" PRIMARY KEY ("deltaId")
);

-- The 48h sweep ranges over this and nothing else does.
CREATE INDEX "usage_delta_seen_seenAt_idx" ON "network"."usage_delta_seen"("seenAt");
CREATE INDEX "usage_delta_seen_configId_observedAt_idx" ON "network"."usage_delta_seen"("configId", "observedAt");

ALTER TABLE "network"."usage_delta_seen"
    ADD CONSTRAINT "usage_delta_seen_bytes_not_negative" CHECK ("upBytes" >= 0 AND "downBytes" >= 0);

-- -----------------------------------------------------------------------------
-- A figure we do not believe
-- -----------------------------------------------------------------------------
CREATE TABLE "network"."usage_delta_quarantine" (
    "id" UUID NOT NULL,
    "deltaId" UUID,
    -- Nullable: attribution is one of the things that can be what failed.
    "configId" UUID,
    "panelId" UUID NOT NULL,
    "upBytes" BIGINT NOT NULL,
    "downBytes" BIGINT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "reason" "network"."QuarantineReason" NOT NULL,
    "state" "network"."UsageDispositionState" NOT NULL DEFAULT 'pending',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByAdminId" UUID,
    "resolutionNote" TEXT,

    CONSTRAINT "usage_delta_quarantine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "usage_delta_quarantine_state_detectedAt_idx" ON "network"."usage_delta_quarantine"("state", "detectedAt");

ALTER TABLE "network"."usage_delta_quarantine"
    ADD CONSTRAINT "usage_delta_quarantine_configId_fkey" FOREIGN KEY ("configId") REFERENCES "network"."config"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "usage_delta_quarantine_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "network"."panel"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "usage_delta_quarantine_bytes_not_negative" CHECK ("upBytes" >= 0 AND "downBytes" >= 0),
    -- A row resolved at no time cannot be aged, audited or reported on, and
    -- a `pending` row with a resolution time is a decision nobody can find.
    ADD CONSTRAINT "usage_delta_quarantine_resolved_has_time" CHECK (("state" = 'pending') = ("resolvedAt" IS NULL));

-- -----------------------------------------------------------------------------
-- Bytes we believe and cannot bill yet
-- -----------------------------------------------------------------------------
CREATE TABLE "network"."usage_hold" (
    "id" UUID NOT NULL,
    "configId" UUID NOT NULL,
    "panelId" UUID NOT NULL,
    "upBytes" BIGINT NOT NULL,
    "downBytes" BIGINT NOT NULL,
    "reason" "network"."HoldReason" NOT NULL,
    "state" "network"."UsageDispositionState" NOT NULL DEFAULT 'pending',
    "heldFrom" TIMESTAMP(3) NOT NULL,
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByAdminId" UUID,
    "resolutionNote" TEXT,

    CONSTRAINT "usage_hold_pkey" PRIMARY KEY ("id")
);

-- The holds queue's one query: everything still open, oldest first.
CREATE INDEX "usage_hold_state_heldAt_idx" ON "network"."usage_hold"("state", "heldAt");
CREATE INDEX "usage_hold_configId_idx" ON "network"."usage_hold"("configId");

ALTER TABLE "network"."usage_hold"
    ADD CONSTRAINT "usage_hold_configId_fkey" FOREIGN KEY ("configId") REFERENCES "network"."config"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "usage_hold_bytes_not_negative" CHECK ("upBytes" >= 0 AND "downBytes" >= 0),
    ADD CONSTRAINT "usage_hold_resolved_has_time" CHECK (("state" = 'pending') = ("resolvedAt" IS NULL));

-- -----------------------------------------------------------------------------
-- The panel-wide stop
-- -----------------------------------------------------------------------------
CREATE TABLE "network"."panel_drift_event" (
    "id" UUID NOT NULL,
    "panelId" UUID NOT NULL,
    "eventType" "network"."PanelDriftEventType" NOT NULL,
    "affectedConfigCount" INTEGER NOT NULL,
    "observedConfigCount" INTEGER NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collectionHalted" BOOLEAN NOT NULL DEFAULT true,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByAdminId" UUID,
    "note" TEXT,

    CONSTRAINT "panel_drift_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "panel_drift_event_panelId_detectedAt_idx" ON "network"."panel_drift_event"("panelId", "detectedAt" DESC);

ALTER TABLE "network"."panel_drift_event"
    ADD CONSTRAINT "panel_drift_event_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "network"."panel"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Both counts, never the ratio: a percentage cannot be checked afterwards,
    -- and an affected count above the observed one is an arithmetic bug that
    -- would otherwise read as a more alarming event than actually happened.
    ADD CONSTRAINT "panel_drift_event_counts_sane" CHECK (
        "affectedConfigCount" >= 0
        AND "observedConfigCount" >= 0
        AND "affectedConfigCount" <= "observedConfigCount");

-- -----------------------------------------------------------------------------
-- The byte we could not place
-- -----------------------------------------------------------------------------
CREATE TABLE "network"."unattributed_usage" (
    "id" UUID NOT NULL,
    "panelId" UUID NOT NULL,
    "remoteIdentifier" TEXT NOT NULL,
    "upBytes" BIGINT NOT NULL DEFAULT 0,
    "downBytes" BIGINT NOT NULL DEFAULT 0,
    "observationCount" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "state" "network"."UnattributedUsageState" NOT NULL DEFAULT 'open',
    "attributedConfigId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "unattributed_usage_pkey" PRIMARY KEY ("id")
);

-- One row per remote client, accumulated. An orphan is re-observed every pass,
-- so per-reading rows would be a row a minute per unclaimed client.
CREATE UNIQUE INDEX "unattributed_usage_panel_remote_key" ON "network"."unattributed_usage"("panelId", "remoteIdentifier");
CREATE INDEX "unattributed_usage_state_lastSeenAt_idx" ON "network"."unattributed_usage"("state", "lastSeenAt");

ALTER TABLE "network"."unattributed_usage"
    ADD CONSTRAINT "unattributed_usage_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "network"."panel"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "unattributed_usage_bytes_not_negative" CHECK (
        "upBytes" >= 0 AND "downBytes" >= 0 AND "observationCount" >= 0),
    -- "We found its owner" is a claim with nothing behind it unless the config
    -- is named — and the bytes would be dropped under a state saying they were
    -- not.
    ADD CONSTRAINT "unattributed_usage_attributed_has_config" CHECK (
        ("state" = 'attributed') = ("attributedConfigId" IS NOT NULL));
