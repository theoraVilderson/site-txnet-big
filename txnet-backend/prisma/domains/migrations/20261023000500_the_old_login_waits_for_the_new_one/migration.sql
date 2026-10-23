-- F-1601-d2 — the old login waits for the new one (ADR-0160 decision 11).
--
-- A move no longer retires the row it leaves: that row keeps serving until the
-- row that replaced it is confirmed on its panel, then a grace of 3 days, so
-- a user who typed a login or copied a config by hand is never cut off while
-- changing their device. `supersededById` names the replacement; `retireAt`
-- is set when the sweep tells the user, and the sweep retires the row then.
--
-- Additive: two nullable columns, a foreign key and an index, no backfill — a
-- move made before this has already retired its old row. Rollback: drop the
-- index, the constraint and the two columns.

ALTER TABLE "network"."config"
    ADD COLUMN "supersededById" UUID,
    ADD COLUMN "retireAt" TIMESTAMP(3);

ALTER TABLE "network"."config"
    ADD CONSTRAINT "config_supersededById_fkey" FOREIGN KEY ("supersededById")
    REFERENCES "network"."config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A row is never its own replacement.
ALTER TABLE "network"."config"
    ADD CONSTRAINT "config_superseded_by_another" CHECK ("supersededById" IS NULL OR "supersededById" <> "id");

CREATE INDEX "config_supersededById_idx" ON "network"."config"("supersededById");
