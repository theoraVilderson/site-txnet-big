-- F-027-ee — a panel group member that is broken or gone can be removed now
-- (network `contract.groups.md` rule 16).
--
-- 1. `panel_group_member.evictedAt`: the owner chose "remove now". The drain
--    sweep retires every config of the group's Grants on the member on its
--    next tick — no wait, no hold — then deletes the member. CHECK: only on a
--    `drain` member; eviction sets `role = drain` with it, so the drain clock,
--    `/sub`'s drain rule and fulfilment's "takes no new Grants" all apply.
-- 2. `panel_group_member_drain_clock` also clears `evictedAt` when the member
--    leaves `drain`, as it clears `drainingSince`.
--
-- Additive: a nullable column, no row has it. Rollback: drop the CHECK and the
-- column, and restore the function from 20260924001100.

-- AlterTable
ALTER TABLE "network"."panel_group_member" ADD COLUMN "evictedAt" TIMESTAMP(3);

ALTER TABLE "network"."panel_group_member"
  ADD CONSTRAINT "panel_group_member_evicted_is_drain"
  CHECK ("evictedAt" IS NULL OR "role" = 'drain');

CREATE OR REPLACE FUNCTION network.panel_group_member_drain_clock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."role" <> 'drain' THEN
    NEW."drainingSince" := NULL;
    NEW."evictedAt" := NULL;
  ELSIF TG_OP = 'UPDATE' AND OLD."role" = 'drain' THEN
    NEW."drainingSince" := OLD."drainingSince";
  ELSE
    NEW."drainingSince" := now() AT TIME ZONE 'UTC';
  END IF;
  RETURN NEW;
END
$$;
