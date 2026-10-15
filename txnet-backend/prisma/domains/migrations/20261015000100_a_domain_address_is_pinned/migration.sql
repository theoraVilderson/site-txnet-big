-- F-027-ez — a domain address is pinned to the IPs it was accepted at
-- (ADR-0130 decision 4, D-67). The connection test records what it dialed;
-- every turn resolves the name once and dials only a known address. None
-- known among the answers: the login is not sent, and a halting
-- `address_moved` names the old addresses and the new ones.
--
-- Additive: two panel columns with defaults, one enum value, two nullable
-- event columns. The CHECK compares the type as text, so it does not use the
-- enum value this same migration adds.

ALTER TYPE "network"."PanelDriftEventType" ADD VALUE 'address_moved';

ALTER TABLE "network"."panel"
    ADD COLUMN "knownAddresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "addressMayMove" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "network"."panel_drift_event"
    ADD COLUMN "knownAddresses" TEXT[],
    ADD COLUMN "seenAddresses" TEXT[],
    ADD CONSTRAINT "panel_drift_event_addresses_are_a_move"
        CHECK (("knownAddresses" IS NULL AND "seenAddresses" IS NULL)
               OR ("eventType"::text = 'address_moved'
                   AND "knownAddresses" IS NOT NULL AND "seenAddresses" IS NOT NULL));
