-- F-027-cx — the lease planner's state, on the tables that already exist.
--
-- ADR-0093 rule 4: `quotaengine/schema.sql` is reference only. Its `panels`
-- are `network.panel`, its `replicas` are `network.config` (counter in
-- `config_counter_state`, limit seen = `appliedCeilingBytes`, limit wanted =
-- `allocatedCeilingBytes`), and its `subscriptions` are the Grant, whose
-- Quota and Used the planner reads and never copies. What is left is what the
-- planner learns and would lose on a restart: a panel's tick clock and
-- enforcement lag, a config's pessimistic limit, unconfirmed write and rates.
--
-- Additive: every column nullable or defaulted, nothing reads them until the
-- shadow planner (F-027-cy). Rollback: drop the columns and constraints.

ALTER TABLE "network"."panel" ADD COLUMN "tickPeriodMs" INTEGER;
ALTER TABLE "network"."panel" ADD COLUMN "tickPhaseMask" BIGINT;
ALTER TABLE "network"."panel" ADD COLUMN "lagMeanSec" DOUBLE PRECISION;
ALTER TABLE "network"."panel" ADD COLUMN "lagVarianceSec2" DOUBLE PRECISION;
ALTER TABLE "network"."panel" ADD COLUMN "lagSamples" INTEGER NOT NULL DEFAULT 0;

-- A phase is bins of a period: no mask without one, and 32 bins at most.
ALTER TABLE "network"."panel" ADD CONSTRAINT "panel_tick_phase_needs_period" CHECK (
  ("tickPeriodMs" IS NULL OR "tickPeriodMs" > 0)
  AND ("tickPhaseMask" IS NULL
       OR ("tickPeriodMs" IS NOT NULL AND "tickPhaseMask" BETWEEN 0 AND 4294967295))
);

-- An estimate exists exactly when a sample does; a lag and a variance are never negative.
ALTER TABLE "network"."panel" ADD CONSTRAINT "panel_lag_matches_samples" CHECK (
  "lagSamples" >= 0
  AND ("lagSamples" = 0) = ("lagMeanSec" IS NULL)
  AND ("lagSamples" = 0) = ("lagVarianceSec2" IS NULL)
  AND ("lagMeanSec" IS NULL OR "lagMeanSec" >= 0)
  AND ("lagVarianceSec2" IS NULL OR "lagVarianceSec2" >= 0)
);

ALTER TABLE "network"."config" ADD COLUMN "limitPeakBytes" BIGINT;
ALTER TABLE "network"."config" ADD COLUMN "writePending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "network"."config" ADD COLUMN "rateFastBps" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "network"."config" ADD COLUMN "rateSlowBps" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "network"."config" ADD CONSTRAINT "config_lease_state_not_negative" CHECK (
  ("limitPeakBytes" IS NULL OR "limitPeakBytes" >= 0)
  AND "rateFastBps" >= 0
  AND "rateSlowBps" >= 0
);
