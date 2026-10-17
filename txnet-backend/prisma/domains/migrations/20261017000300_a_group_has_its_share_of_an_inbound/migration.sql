-- F-027-eq — a group's share of an inbound (ADR-0127 decision 3; network
-- `contract.inbounds.md` rule 5). A listing may carry its own `maxClients`:
-- the most of that group's Grants with a live config on the inbound. It counts
-- only the group's own, as a member-layer `maxClients` now does on the panel;
-- the inbound's and the panel layer's `maxClients` stay physical caps over
-- every Grant. Fulfilment needs every cap that applies to have room.
--
-- Expand only: a new nullable column, null = no share, so every listing sells
-- as it did. Rollback: drop the column.

-- AlterTable
ALTER TABLE "network"."panel_group_member_inbound" ADD COLUMN "maxClients" INTEGER,
  ADD CONSTRAINT "panel_group_member_inbound_max_clients_positive" CHECK ("maxClients" IS NULL OR "maxClients" >= 1);
