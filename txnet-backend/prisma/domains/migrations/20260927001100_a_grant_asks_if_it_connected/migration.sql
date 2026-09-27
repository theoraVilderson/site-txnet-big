-- F-601-c: "not connected yet?" — an active Grant with nothing consumed 24 h
-- and again 72 h after activation is told how to connect. `activatedAt` is
-- when it first turned `active`; `unusedCheckAt` is the next check, cleared
-- after the second notice or at the first consumed byte. Existing Grants get
-- neither: nobody is asked about a service they were given before this.
--
-- Additive; rollback: drop the index and the two columns, nothing else reads them.

ALTER TABLE "entitlement"."grant"
  ADD COLUMN "activatedAt" TIMESTAMP(3),
  ADD COLUMN "unusedCheckAt" TIMESTAMP(3);

CREATE INDEX "grant_status_unusedCheckAt_idx" ON "entitlement"."grant" ("status", "unusedCheckAt");
