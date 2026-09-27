-- F-027-di (SPEC weakness #24, #25): a third placement, `hrw` — a buyer gets
-- K of the member's picked inbounds, chosen by the Grant's rendezvous hash, so
-- an inbound lost moves only the buyers it held. K is a fifth selling setting,
-- `inboundsPerBuyer`, resolved member -> panel -> platform (2) like the other
-- four (ADR-0090 decision 2). Additive: no row changes, no effective value
-- changes — nothing places `hrw` until an admin says so.

ALTER TYPE "network"."InboundPlacement" ADD VALUE 'hrw';

ALTER TABLE "network"."panel"
  ADD COLUMN "inboundsPerBuyer" INTEGER,
  ADD CONSTRAINT "panel_inbounds_per_buyer_positive" CHECK ("inboundsPerBuyer" IS NULL OR "inboundsPerBuyer" >= 1);

ALTER TABLE "network"."panel_group_member"
  ADD COLUMN "inboundsPerBuyer" INTEGER,
  ADD CONSTRAINT "panel_group_member_inbounds_per_buyer_positive" CHECK ("inboundsPerBuyer" IS NULL OR "inboundsPerBuyer" >= 1);
