-- F-027-du — a push config remembers User Manager's own total for it.
--
-- `sessionBaselineBytes` assumes the router's per-user total restarts only
-- when we create the client. A user an operator deletes and makes again by
-- hand, under the same name, restarts it without us: the allocation would be
-- served again. The push turn now reads the router's own totals, and this is
-- the last one it read. A total below it is a restart, and the baseline moves
-- to what our Σ holds beyond the router's figure. Null: never read since the
-- client was created, so the next read sets the baseline the same way.
--
-- Additive: a nullable column. Rollback: drop it; a re-made-by-hand user is
-- then over-served again.

ALTER TABLE "network"."config" ADD COLUMN "sessionCounterBytes" BIGINT;

ALTER TABLE "network"."config" ADD CONSTRAINT "config_session_counter_not_negative"
    CHECK ("sessionCounterBytes" IS NULL OR "sessionCounterBytes" >= 0);
