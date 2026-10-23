-- F-027-ag-b — a User Manager router is read, not heard.
--
-- A RouterOS NAS sends a session's accounting only to the RADIUS server that
-- logged the user in, which on a User Manager deployment is User Manager
-- itself (proved on a CHR, network contract.usermanager.md rule 11). Our
-- receiver never hears one, so such a panel is not `push`: each user's
-- lifetime total is read off the router's REST API, a `cumulative` counter,
-- like any pulled panel (ADR-0161).
--
-- A User Manager panel registered `push` is re-declared. Its RADIUS secret
-- reference served a receiver that never got a packet, and a pull panel holds
-- none (CHECK `panel_radius_secret_is_push_only`), so it is cleared; the vault
-- entry it named is left unread. Its configs have no raw cursor yet, so the
-- first pull read adopts the router's figure and bills only what follows.
--
-- Rewrites only User Manager panels still `push`: none on dev (2026-10-23).
-- Rollback: set them back to `push` / `session`; the secret is re-entered.

UPDATE "network"."panel"
   SET "transport" = 'pull',
       "counterSemantics" = 'cumulative',
       "panelRadiusSecret" = NULL
 WHERE "driverType" = 'mikrotik_user_manager'
   AND "transport" = 'push';
