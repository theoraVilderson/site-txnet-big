-- F-601-a — the retention ledger: each retention notice is told once per Grant
-- period. One row per (Grant, notice, period); `eventId` is the outbox event
-- that claimed it, so the same event's redelivery claims again and a second
-- event for that period is refused. No `tenantId` and no RLS, like
-- `notification`: only `notification-service`'s internal seam writes it. The
-- schema's default privileges (20260909000500) grant it to both app roles.
--
-- Rollback: drop the table.

CREATE TABLE "notification"."retention_notice" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "notice" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "eventId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "retention_notice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "retention_notice_grantId_notice_period_key"
  ON "notification"."retention_notice" ("grantId", "notice", "period");
