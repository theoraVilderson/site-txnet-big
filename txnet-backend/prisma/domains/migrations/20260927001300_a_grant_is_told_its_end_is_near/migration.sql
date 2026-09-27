-- F-601-e: an active Grant is told 7, 3 and 1 day(s) before its end.
-- `endNoticeFor` is the end the clock was last set for, `endNoticeAt` that
-- end's next level. A renewal moves `endsAt` away from `endNoticeFor`, which
-- is what makes the Grant due again — no writer of `endsAt` resets the clock.
-- Existing Grants get neither: the first sweep sets them from their end.
--
-- Additive; rollback: drop the index and the two columns, nothing else reads them.

ALTER TABLE "entitlement"."grant"
  ADD COLUMN "endNoticeFor" TIMESTAMP(3),
  ADD COLUMN "endNoticeAt" TIMESTAMP(3);

CREATE INDEX "grant_status_endsAt_idx" ON "entitlement"."grant" ("status", "endsAt");
