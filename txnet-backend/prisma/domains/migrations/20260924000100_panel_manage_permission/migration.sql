-- F-027-ar (ADR-0080 decision 2) — the systems surface's door, `panel.manage`.
--
-- Granted to no role: SuperAdmin holds it as `*`, and the platform owner is
-- the only tenant the routes admit anyway (`PanelRegistrationService`). Unlike
-- `gateway.manage`, a reseller's Admin is not given it — registering a panel
-- is closed to resellers (network/open-questions.md), and a door that every
-- reseller admin passes only to be refused behind it is a door that says
-- nothing.
--
-- Rollback: delete the `panel.manage` permission row.

INSERT INTO identity.permission (id, key)
VALUES (gen_random_uuid(), 'panel.manage')
ON CONFLICT (key) DO NOTHING;
