-- F-030-a (ADR-0138 (7)): a key given to one person may hold for a window.
-- `startsAt`/`endsAt` bound it; outside them the reader counts nothing.
-- `openedAt` is the sweep's mark that the start passed and the person was
-- told: setting it is an UPDATE, so `user_permission_changed` moves the
-- token at the moment the key starts to count, as a delete does at its end.
-- A take carries no window (the writer refuses one).
--
-- The unused `governance.temporal_access_grant` leaves the schema: a window
-- is a column on the one row a key given to a person already is, not a fourth
-- source of keys. Read or written by no code since the first draft; 0 rows on
-- dev, 2026-10-13; dropping it was asked and approved (user, 2026-10-13).
--
-- Rollback: drop the three columns, the check and the two indexes; the
-- table and its two enums are in 20260908000000_init.

-- AlterTable
ALTER TABLE "identity"."user_permission" ADD COLUMN "startsAt" TIMESTAMP(3),
ADD COLUMN "endsAt" TIMESTAMP(3),
ADD COLUMN "openedAt" TIMESTAMP(3);

ALTER TABLE "identity"."user_permission" ADD CONSTRAINT "user_permission_window_ok"
  CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt");

-- CreateIndex
CREATE INDEX "user_permission_startsAt_idx" ON "identity"."user_permission"("startsAt");

-- CreateIndex
CREATE INDEX "user_permission_endsAt_idx" ON "identity"."user_permission"("endsAt");

DROP TABLE "governance"."temporal_access_grant"; -- contract: F-030-a

DROP TYPE "governance"."GrantMode"; -- contract: F-030-a

DROP TYPE "governance"."GrantResourceType"; -- contract: F-030-a
