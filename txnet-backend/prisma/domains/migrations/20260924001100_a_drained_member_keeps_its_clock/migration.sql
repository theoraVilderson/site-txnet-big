-- F-027-bm — a panel group member is drained without cutting a user off
-- (catalog §7.3, network `contract.groups.md` rules 13-15).
--
-- 1. `panel_group_member.drainingSince`: the wait before a drained member's
--    configs go is counted from it. Set by the database's clock, not a
--    caller's: the trigger stamps it when `role` becomes `drain`, keeps it
--    while the member stays `drain` (a rewrite of the role or of the column
--    does not restart or shorten the wait), and clears it when the member
--    leaves `drain`. CHECK: a time exactly when draining.
-- 2. `sub_member_changed`: `/sub` drops a drain line while the Grant has
--    another, so a role moving into or out of `drain` changes renders. It
--    notifies as the panel (`{"kind":"panel","id":<panelId>}`), which is
--    already the generation every render with a line of that panel is stamped
--    under — no new payload kind, no change to `sub-service`'s listener.
--
-- Additive. No member is `drain` on dev, so the CHECK validates against
-- nothing. Rollback: drop the two triggers, their functions, the CHECK and the
-- column.

-- AlterTable
ALTER TABLE "network"."panel_group_member" ADD COLUMN "drainingSince" TIMESTAMP(3);

ALTER TABLE "network"."panel_group_member"
  ADD CONSTRAINT "panel_group_member_draining_since_iff_drain"
  CHECK (("role" = 'drain') = ("drainingSince" IS NOT NULL));

CREATE FUNCTION network.panel_group_member_drain_clock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."role" <> 'drain' THEN
    NEW."drainingSince" := NULL;
  ELSIF TG_OP = 'UPDATE' AND OLD."role" = 'drain' THEN
    NEW."drainingSince" := OLD."drainingSince";
  ELSE
    NEW."drainingSince" := now() AT TIME ZONE 'UTC';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER panel_group_member_drain_clock
  BEFORE INSERT OR UPDATE OF "role", "drainingSince" ON "network"."panel_group_member"
  FOR EACH ROW EXECUTE FUNCTION network.panel_group_member_drain_clock();

CREATE FUNCTION network.notify_sub_member_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."role" = 'drain' THEN
      PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'panel', 'id', OLD."panelId")::text);
    END IF;
  ELSIF (OLD."role" = 'drain') IS DISTINCT FROM (NEW."role" = 'drain') THEN
    PERFORM pg_notify('sub_invalidate', json_build_object('kind', 'panel', 'id', NEW."panelId")::text);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER sub_member_changed
  AFTER UPDATE OF "role" OR DELETE ON "network"."panel_group_member"
  FOR EACH ROW EXECUTE FUNCTION network.notify_sub_member_changed();
