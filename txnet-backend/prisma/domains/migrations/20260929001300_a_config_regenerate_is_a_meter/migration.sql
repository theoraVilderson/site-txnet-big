-- F-118-q (D-58, ADR-0105 decision 7): the first per-use meter. A config
-- regenerated on a VPN Grant (`POST /api/billing/traffic/configs/actions`,
-- `regenerate`) is one unit, counted by billing-service, which runs the work.
-- The row is the only thing this migration ships: a card on it stays refused
-- (`rate_card_not_served`) and a Grant carrying one stays unsold
-- (`meter_not_served`) until F-118-h's door refuses unfunded regenerations.
-- Its name starts as the key, as `vpn.traffic`'s did; a human names it.
INSERT INTO "catalog"."meter" ("id", "key", "unit", "reportedBy", "nameKey")
VALUES (gen_random_uuid(), 'vpn.config.regenerate', 'count', 'billing-service', 'catalog.meter.vpn.config.regenerate.name');
