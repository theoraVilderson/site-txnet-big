-- F-027-eg — a Grant an evict leaves with no line is paused or refunded, as
-- the owner chose (network `contract.groups.md` rule 16).
--
-- 1. `panel_group_member.evictOrphans` / `evictedBy`: the owner's choice and
--    who made it, set with `evictedAt` and only with it (CHECK). The drain
--    clock trigger clears all three when the member leaves `drain`.
-- 2. `grant.awaitingPanel`: frozen by an evict, so the drain sweep unfreezes
--    it once the group has a healthy member. Trigger
--    `grant_awaiting_panel_is_frozen` clears it whenever the Grant is not a
--    suspended `admin_frozen` one, so no later admin freeze is lifted by it.
--
-- Additive: no member is evicted with a choice yet, no Grant awaits. A member
-- already marked `evictedAt` without a choice would fail the CHECK, so one is
-- given `pause` — the choice that cuts nothing off for good. Rollback: drop
-- the triggers, the CHECK, the three columns and the enum, and restore the
-- function from 20261006000300.

CREATE TYPE "network"."EvictOrphans" AS ENUM ('pause', 'refund');

ALTER TABLE "network"."panel_group_member"
  ADD COLUMN "evictOrphans" "network"."EvictOrphans",
  ADD COLUMN "evictedBy" UUID;

UPDATE "network"."panel_group_member" SET "evictOrphans" = 'pause' WHERE "evictedAt" IS NOT NULL;

ALTER TABLE "network"."panel_group_member"
  ADD CONSTRAINT "panel_group_member_evict_choice_with_evict"
  CHECK (("evictedAt" IS NULL) = ("evictOrphans" IS NULL) AND ("evictedBy" IS NULL OR "evictedAt" IS NOT NULL));

CREATE OR REPLACE FUNCTION network.panel_group_member_drain_clock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."role" <> 'drain' THEN
    NEW."drainingSince" := NULL;
    NEW."evictedAt" := NULL;
    NEW."evictOrphans" := NULL;
    NEW."evictedBy" := NULL;
  ELSIF TG_OP = 'UPDATE' AND OLD."role" = 'drain' THEN
    NEW."drainingSince" := OLD."drainingSince";
  ELSE
    NEW."drainingSince" := now() AT TIME ZONE 'UTC';
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE "entitlement"."grant" ADD COLUMN "awaitingPanel" BOOLEAN NOT NULL DEFAULT false;

CREATE FUNCTION entitlement.grant_awaiting_panel_is_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'suspended' OR NEW."statusReason" IS DISTINCT FROM 'admin_frozen' THEN
    NEW."awaitingPanel" := false;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER grant_awaiting_panel_is_frozen
  BEFORE INSERT OR UPDATE ON "entitlement"."grant"
  FOR EACH ROW EXECUTE FUNCTION entitlement.grant_awaiting_panel_is_frozen();
