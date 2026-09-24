-- F-027-az — a push panel keeps its RADIUS secret apart from its API login.
--
-- A push panel is two things at once: a REST API its driver signs in to, and a
-- NAS that signs every accounting packet with a shared secret. One vault login
-- cannot be both, so the secret gets a vault reference of its own
-- (`vault:<tenantId>:panel_credentials:panel:<panelId>:radius`). The column
-- holds the reference, never the secret, as `panelApiCredentials` does.
--
-- Only a push panel has a NAS, hence the CHECK. It is not required on a push
-- panel: rows registered before this change have none, and the allowlist
-- leaves such a panel off and logs it rather than guessing a secret.
--
-- Additive and nullable: no backfill. Rollback: drop the constraint and the
-- column.

ALTER TABLE "network"."panel" ADD COLUMN "panelRadiusSecret" TEXT;

ALTER TABLE "network"."panel"
    ADD CONSTRAINT "panel_radius_secret_is_push_only"
    CHECK ("panelRadiusSecret" IS NULL OR "transport" = 'push');
