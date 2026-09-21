-- F-027-f — a Grant buys its bytes before it serves them, and a suspended one
-- is purged on a clock (ADR-0072, ADR-0073, ADR-0075).
--
-- F-027-a..e gave the network plane what it needs to measure. This is what the
-- entitlement side has to hold before a single metered byte may move.
--
-- 1. `purchasedBytes` is a **third** cursor, beside the `billedBytes` this
--    table already had. ADR-0072 rule 1 bounds the allocator by it —
--    `Σ ceilings ≤ purchasedBytes` across every config of one Grant — and
--    `billedBytes` stays what it always was, the money cursor. Folded into
--    one column the ceiling is written against a number that moves for a
--    different reason, and the failure has no symptom: traffic is simply
--    served past what anyone paid for.
-- 2. `consumedBytes` is what the panels reported (F-027-n) — measured, not
--    paid for. Deliberately **not** CHECKed against `purchasedBytes`: a panel
--    whose limit someone overrode serves past the ceiling, and that is an
--    accounting truth the holds queue settles (ADR-0074), not a write to
--    refuse. A constraint here would crash the delta consumer at exactly the
--    moment the money hole it exists to find opens.
-- 3. `meteredRate` is `(18, 8)`, the precision `tenant.tenant_usage_meter`
--    and `currency_exchange_rate` already use (ADR-0073). `C-02` governs
--    amounts, and every amount derived from this rate is rounded to whole
--    cents before the ledger sees it (ADR-0072), so nothing finer than two
--    places is ever written as money. It is copied at issue, beside the
--    quotas, so a catalog price change never reprices blocks already bought.
-- 4. `suspendedAt` starts the purge clock (ADR-0075). `grant_suspended_has_a_
--    clock` refuses a suspension without one, because a Grant that is never
--    due is a panel seat held forever with nothing red anywhere.
-- 5. `purgeAfterDays` lives on the **tenant** as the setting, default 7, `0` =
--    never, read as it is now — a tenant that shortens it means it for the
--    Grants already waiting, which is why it is not copied onto the Grant at
--    issue the way the rate is. The Grant's own column is an override and is
--    null unless someone deliberately set one.
--
-- Additive: every column is nullable or defaulted. The two non-negativity
-- constraints also cover the pre-existing `billedBytes`, which is defaulted to
-- 0 and has never been written by anything (`GrantService` does not touch it).
--
-- Rollback: drop the four constraints, the index and the seven columns. The
-- `tenant` column has no dependents outside this file until F-027-y.

-- -----------------------------------------------------------------------------
-- entitlement."grant" — the cursors, the locked rate, the clock
-- -----------------------------------------------------------------------------
ALTER TABLE "entitlement"."grant"
    ADD COLUMN "consumedBytes"  BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "purchasedBytes" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "meteredRate"    DECIMAL(18, 8),
    ADD COLUMN "suspendedAt"    TIMESTAMP(3),
    ADD COLUMN "purgeAfterDays" INTEGER;

-- The purge job's only scan (F-027-y): which suspended Grants are now due.
-- Without it that is a sequential pass over every Grant on the platform, hourly.
CREATE INDEX "grant_status_suspendedAt_idx" ON "entitlement"."grant"("status", "suspendedAt");

ALTER TABLE "entitlement"."grant"
    -- A counter going backward is a reset, never negative usage (ADR-0074).
    ADD CONSTRAINT "grant_byte_counters_not_negative" CHECK (
        "billedBytes" >= 0 AND "consumedBytes" >= 0 AND "purchasedBytes" >= 0),
    ADD CONSTRAINT "grant_metered_rate_not_negative" CHECK ("meteredRate" IS NULL OR "meteredRate" >= 0),
    -- A prepaid Grant priced per byte is a rate nobody reads and a second,
    -- contradictory answer to what the user owes.
    ADD CONSTRAINT "grant_metered_rate_is_metered" CHECK (
        "meteredRate" IS NULL OR "billingMode" = 'metered'),
    -- ADR-0075: purge is due `purgeAfterDays` after `suspendedAt`. A suspension
    -- with no timestamp is never due.
    ADD CONSTRAINT "grant_suspended_has_a_clock" CHECK (
        NOT ("status" = 'suspended' AND "suspendedAt" IS NULL)),
    ADD CONSTRAINT "grant_purge_days_not_negative" CHECK (
        "purgeAfterDays" IS NULL OR "purgeAfterDays" >= 0);

-- -----------------------------------------------------------------------------
-- tenant.tenant — the setting the clock is read from
-- -----------------------------------------------------------------------------
ALTER TABLE "tenant"."tenant"
    ADD COLUMN "purgeAfterDays" INTEGER NOT NULL DEFAULT 7;

ALTER TABLE "tenant"."tenant"
    -- `0` is "never purge" (a tenant's choice; the drift report counts what it
    -- accumulates). A negative window would make every suspension due at once.
    ADD CONSTRAINT "tenant_purge_days_not_negative" CHECK ("purgeAfterDays" >= 0);
