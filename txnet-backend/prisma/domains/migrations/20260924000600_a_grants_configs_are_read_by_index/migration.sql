-- F-027-bn — a Grant's configs are read through an index.
--
-- `sub-service` reads every config of one Grant, oldest first, on each `/sub`
-- cache miss (sub-api contract, "What is served"). Postgres does not index a
-- foreign key by itself, so without this the read scans every tenant's
-- configs. `(grantId, createdAt)` serves the filter and the order together.
--
-- Additive. Rollback: DROP INDEX "network"."config_grantId_createdAt_idx".

CREATE INDEX "config_grantId_createdAt_idx" ON "network"."config"("grantId", "createdAt");
