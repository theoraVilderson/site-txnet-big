-- F-1002-i: a cost can be taken back. History stays (`cost_is_history`: no row
-- is changed or deleted); taking a cost back is a new row with none — a
-- variant's `amount` null, a meter's `unitSize` and `unitCost` both null —
-- read as "not set" from its `effectiveFrom`, which 0 is not (ADR-0151 (5)).
-- Expand only: a column may now be null, and every row written before has one.
-- Rollback: once no row has a null, SET NOT NULL again and drop the CHECK.

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_variant_cost_unset';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_meter_cost_unset';

ALTER TABLE "catalog"."variant_cost" ALTER COLUMN "amount" DROP NOT NULL;
ALTER TABLE "catalog"."meter_cost"
    ALTER COLUMN "unitSize" DROP NOT NULL,
    ALTER COLUMN "unitCost" DROP NOT NULL,
    ADD CONSTRAINT "meter_cost_unset_whole" CHECK (("unitSize" IS NULL) = ("unitCost" IS NULL));
