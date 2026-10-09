-- GR-1-a (ADR-0139 (3)): a group membership may end. An ended membership
-- counts for nothing wherever membership is asked (`liveMembership`); GR-1-c's
-- sweep recomputes the person when it ends.
--
-- Moving or clearing the end moves that person's token, as joining or leaving
-- does (`notify_group_member_changed`, migration 20261009000600).
--
-- Rollback: drop the trigger, the index and the column.

-- AlterTable
ALTER TABLE "governance"."user_group_member" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "user_group_member_expiresAt_idx" ON "governance"."user_group_member"("expiresAt");

CREATE TRIGGER user_group_member_end_moved
  AFTER UPDATE OF "expiresAt" ON governance.user_group_member
  FOR EACH ROW WHEN (OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt")
  EXECUTE FUNCTION governance.notify_group_member_changed();
