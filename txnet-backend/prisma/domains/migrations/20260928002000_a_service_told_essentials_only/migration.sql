-- F-601-o — a buyer sets one of their services to essential notices only
-- (cutoff and purge): a retention notice of any other kind on that Grant is
-- claimed `muted`. One row per (user, Grant) set to anything but `all`; no
-- row means every notice. No `tenantId` or RLS, like
-- `notification_preference`; the schema's default privileges
-- (20260909000500) grant it to both app roles.
--
-- Additive; rollback: drop the table.

CREATE TABLE "notification"."notification_grant_preference" (
  "userId" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "level" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_grant_preference_pkey" PRIMARY KEY ("userId", "grantId")
);
