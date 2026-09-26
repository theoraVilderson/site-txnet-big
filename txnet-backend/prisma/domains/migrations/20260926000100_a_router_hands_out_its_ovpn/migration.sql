-- F-307-d — a MikroTik User Manager router hands its buyers one .ovpn file.
--
-- A User Manager OpenVPN login is a name and a password; the client file
-- (server address, CA, `auth-user-pass`) is the same for every user of the
-- router, and RouterOS's API does not return it. So the router's admin uploads
-- it once, and billing hands it to the owner of each OpenVPN config on that
-- router beside their login (user, 2026-09-26).
--
-- Only User Manager logs users in this way, hence the CHECK. 64 KiB is well
-- above a real profile (a CA and a dozen directives) and bounds what a list
-- reads. No private key is refused here: that is the API's check, and a row
-- written by hand is the operator's.
--
-- Additive and nullable: no backfill. Rollback: drop the constraints and the
-- column.

ALTER TABLE "network"."panel" ADD COLUMN "ovpnProfile" TEXT;

ALTER TABLE "network"."panel"
    ADD CONSTRAINT "panel_ovpn_profile_is_user_manager"
    CHECK ("ovpnProfile" IS NULL OR "driverType" = 'mikrotik_user_manager');

ALTER TABLE "network"."panel"
    ADD CONSTRAINT "panel_ovpn_profile_is_bounded"
    CHECK ("ovpnProfile" IS NULL OR octet_length("ovpnProfile") <= 65536);
