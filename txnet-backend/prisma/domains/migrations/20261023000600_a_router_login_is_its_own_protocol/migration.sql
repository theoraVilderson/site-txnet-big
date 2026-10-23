-- F-1601-d3 — a router login is its own protocol (user 2026-10-23).
--
-- A User Manager login is a name and a password that every dial-in service of
-- the router takes — PPPoE, L2TP, OpenVPN alike. Its NAS inbounds named no
-- protocol, so neither a purchase nor a move ever placed a user there. They
-- now name `router_login`, and so does a config on them.
--
-- Its own file: a value added to an enum cannot be used in the transaction
-- that adds it; the next migration moves the rows. Additive. Rollback: none
-- needed while no row holds it (Postgres cannot drop an enum value).

ALTER TYPE "network"."ConfigProtocol" ADD VALUE IF NOT EXISTS 'router_login';
