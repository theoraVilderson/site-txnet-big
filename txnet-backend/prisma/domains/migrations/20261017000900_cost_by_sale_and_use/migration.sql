-- F-1002-e (ADR-0151): the cost rollup prices a sale at its variant's cost and
-- a meter's use at its unit cost (catalog `variant_cost`, `meter_cost`), and a
-- reseller's wholesale charge lands on the Grant it names.
--
-- `costsFrom`: a cost written from an earlier day (a catalog cost from the 1st
-- of the month, a panel's new price) — the next pass restates that tenant's
-- cost rows from it, then clears it, so a closed day is never left priced by
-- the cost that was in effect before the write.
--
-- Every tenant is rebuilt once: wholesale charges move from the bytes split
-- onto their Grants.

ALTER TYPE "billing"."AnalyticsCostKind" ADD VALUE IF NOT EXISTS 'sale';
ALTER TYPE "billing"."AnalyticsCostKind" ADD VALUE IF NOT EXISTS 'usage';

ALTER TABLE "billing"."analytics_rollup_state" ADD COLUMN "costsFrom" DATE;

UPDATE "billing"."analytics_rollup_state" SET "rebuildingSince" = now();
