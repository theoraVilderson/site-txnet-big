-- F-027-ep — an inbound is sold by every group, or by the groups it lists
-- (ADR-0127 decisions 1-2; network `contract.inbounds.md` rule 3a). Amends
-- F-027-ch, where an inbound was the default pool's or exactly one group's and
-- a membership with any assignment stopped selling the pool.
--
-- `panel_inbound.audience`: `every_group` is today's pool — sold by every
-- membership of the panel while `sold`; `listed` is sold by exactly the
-- memberships in `panel_group_member_inbound`, none, one or several. The
-- unique `(panelId, inboundRemoteId)` goes, so one router's OpenVPN can be
-- listed to groups A, B and C. A membership sells its listed inbounds *plus*
-- the panel's `every_group` ones.
--
-- **The migration moves nobody** (decision 2):
--   1. an assigned inbound becomes `listed`, with its one group;
--   2. on a panel where any member has an assignment, every pool inbound —
--      `sold`, assigned to nobody — becomes `listed` to the members without
--      one, which sold it until now; the members with one did not, and still
--      do not. With no such member it is listed to nobody, as nobody sold it;
--   3. elsewhere the pool stays `every_group`, and an unpicked inbound stays
--      `every_group` everywhere: nobody sells it until the admin picks it.
-- So no group gains or loses an inbound, and every placed config stays.
--
-- Rollback: only while no inbound is listed to two memberships — drop the two
-- triggers and functions, delete the listings step 2 wrote, restore the unique
-- index, drop the column and the type.

-- CreateEnum
CREATE TYPE "network"."InboundAudience" AS ENUM ('every_group', 'listed');

-- AlterTable
ALTER TABLE "network"."panel_inbound" ADD COLUMN "audience" "network"."InboundAudience" NOT NULL DEFAULT 'every_group';

-- An inbound may be listed to several memberships now.
DROP INDEX "network"."panel_group_member_inbound_panelId_inboundRemoteId_key"; -- contract: F-027-ep

-- CreateIndex
CREATE INDEX "panel_group_member_inbound_panelId_inboundRemoteId_idx" ON "network"."panel_group_member_inbound"("panelId", "inboundRemoteId");

-- 1. An assigned inbound is listed, to its one group.
UPDATE "network"."panel_inbound" i
   SET "audience" = 'listed'
 WHERE EXISTS (SELECT 1 FROM "network"."panel_group_member_inbound" a
                WHERE a."panelId" = i."panelId" AND a."inboundRemoteId" = i."remoteId");

-- 2. On a panel with an assignment, the pool is listed to the members that sold it.
INSERT INTO "network"."panel_group_member_inbound" ("groupId", "panelId", "inboundRemoteId")
SELECT m."groupId", m."panelId", i."remoteId"
  FROM "network"."panel_group_member" m
  JOIN "network"."panel_inbound" i ON i."panelId" = m."panelId" AND i."sold" AND i."audience" = 'every_group'
 WHERE EXISTS (SELECT 1 FROM "network"."panel_group_member_inbound" a WHERE a."panelId" = m."panelId")
   AND NOT EXISTS (SELECT 1 FROM "network"."panel_group_member_inbound" a
                    WHERE a."panelId" = m."panelId" AND a."groupId" = m."groupId");

UPDATE "network"."panel_inbound" i
   SET "audience" = 'listed'
 WHERE i."sold" AND i."audience" = 'every_group'
   AND EXISTS (SELECT 1 FROM "network"."panel_group_member_inbound" a WHERE a."panelId" = i."panelId");

-- -----------------------------------------------------------------------------
-- A listing is only on a `listed` inbound, and an inbound is every group's
-- only once nobody lists it: the two states never mix, so `sellingInbounds`
-- never has to choose between them. Billing writes the audience first when it
-- lists, and the listings first when it gives an inbound back.
-- -----------------------------------------------------------------------------
CREATE FUNCTION network.panel_group_member_inbound_is_listed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM network.panel_inbound
                  WHERE "panelId" = NEW."panelId" AND "remoteId" = NEW."inboundRemoteId" AND audience = 'listed') THEN
    RAISE EXCEPTION 'inbound_not_listed: inbound % of panel % is every group''s', NEW."inboundRemoteId", NEW."panelId"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER panel_group_member_inbound_is_listed BEFORE INSERT OR UPDATE OF "panelId", "inboundRemoteId" ON "network"."panel_group_member_inbound"
  FOR EACH ROW EXECUTE FUNCTION network.panel_group_member_inbound_is_listed();

CREATE FUNCTION network.panel_inbound_every_group_lists_nobody() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.audience = 'every_group' AND EXISTS (SELECT 1 FROM network.panel_group_member_inbound
                                               WHERE "panelId" = NEW."panelId" AND "inboundRemoteId" = NEW."remoteId") THEN
    RAISE EXCEPTION 'inbound_still_listed: inbound % of panel % has listings', NEW."remoteId", NEW."panelId"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER panel_inbound_every_group_lists_nobody BEFORE UPDATE OF audience ON "network"."panel_inbound"
  FOR EACH ROW EXECUTE FUNCTION network.panel_inbound_every_group_lists_nobody();
