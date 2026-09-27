-- F-027-cu — the ceiling pass remembers the figure it wrote.
--
-- `appliedCeilingBytes` is what a read confirmed, and it is recorded before
-- that pass writes. A lowering written one pass and raised the next was
-- therefore read back as neither — somebody else's — its raise counted as a
-- repair, and two of those left the config `contested` with every raise held.
-- A panel figure equal to this column is ours; only one that is neither this
-- nor the confirmed figure is foreign.
--
-- Additive, nullable: a config never written has nothing to remember, and the
-- check treats that as today's behaviour. Rollback: drop the column.

ALTER TABLE "network"."config" ADD COLUMN "writtenCeilingBytes" BIGINT;
