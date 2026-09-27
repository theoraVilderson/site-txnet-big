-- F-601-l: "trouble connecting?" — an active Grant that was used and then
-- consumed nothing for 7 days is checked in on once per idle stretch.
-- `idleCheckAt` is 7 days after the last charge that consumed a byte, moved by
-- each such charge and cleared by the check. Existing Grants get none: the
-- clock starts at their next consumed byte.
--
-- Additive; rollback: drop the index and the column, nothing else reads them.

ALTER TABLE "entitlement"."grant"
  ADD COLUMN "idleCheckAt" TIMESTAMP(3);

CREATE INDEX "grant_status_idleCheckAt_idx" ON "entitlement"."grant" ("status", "idleCheckAt");
