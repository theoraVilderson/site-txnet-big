-- F-027-du-b — a User Manager limit counts from its profile link.
--
-- `transfer-limit` counts from the user's profile link, not the user's life
-- (proved on a CHR, network contract.usermanager.md rule 9), while the reading
-- we bill is the user's lifetime total (ADR-0161). A link made again starts
-- the limit at zero and leaves the total where it was, so a ceiling measured
-- on the total would hand the user its allocation again. The cursor keeps the
-- link's `.id` and the total it was first read at; the limit has counted the
-- raw figure less that. Moving it is not a reset: nothing is billed again.
--
-- Additive: two nullable columns and one with a default, no backfill — the
-- first read under a link records it. Rollback: drop the constraint and the
-- three columns.

ALTER TABLE "network"."config_counter_state"
    ADD COLUMN "limitOriginId" TEXT,
    ADD COLUMN "limitOriginBytes" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "limitOriginAt" TIMESTAMP(3);

ALTER TABLE "network"."config_counter_state"
    ADD CONSTRAINT "config_counter_state_limit_origin_not_negative"
    CHECK ("limitOriginBytes" >= 0);
