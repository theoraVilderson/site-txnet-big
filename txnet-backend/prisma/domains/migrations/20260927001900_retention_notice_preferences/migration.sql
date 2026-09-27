-- F-601-m — a user mutes kinds of retention notice and sets quiet hours
-- (spec 9.4). `notification_preference` is one row per user; no row means
-- nothing muted and no quiet hours. A notice claimed inside the quiet window
-- is written to the inbox at once and its bot message is held on its own
-- ledger row (`botAt`, `botTemplate`, `botParams`, `botTenantId`) until the
-- window ends. Neither table has a `tenantId` or RLS, like `notification`
-- (`botTenantId` only names whose bot tells the held message); the schema's default privileges (20260909000500) grant it
-- to both app roles.
--
-- Additive; rollback: drop the table, the index and the four columns.

CREATE TABLE "notification"."notification_preference" (
  "userId" UUID NOT NULL,
  "mutedKinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "quietStart" INTEGER,
  "quietEnd" INTEGER,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Tehran',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "notification"."retention_notice"
  ADD COLUMN "botTenantId" UUID,
  ADD COLUMN "botAt" TIMESTAMP(3),
  ADD COLUMN "botTemplate" TEXT,
  ADD COLUMN "botParams" JSONB;

CREATE INDEX "retention_notice_botAt_idx" ON "notification"."retention_notice" ("botAt");
