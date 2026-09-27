-- F-027-du — a push config's panel counter starts at its create.
--
-- User Manager checks `transfer-limit` against its own per-user total, which
-- starts at zero when the user is created. Our figure for the same client is
-- the Σ of its `radius_session` high-water marks, which a delete and re-make
-- on the router does not zero. So the config keeps that Σ as it stood when
-- provisioning last created its client: the router's counter is Σ − this,
-- and this is the offset every ceiling on the panel is translated by.
--
-- Additive: a column defaulting to 0, which is every config created so far
-- (no push panel has carried one). Rollback: drop it; a re-made User Manager
-- user is then served its allocation again from zero.

ALTER TABLE "network"."config" ADD COLUMN "sessionBaselineBytes" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "network"."config" ADD CONSTRAINT "config_session_baseline_not_negative"
    CHECK ("sessionBaselineBytes" >= 0);
