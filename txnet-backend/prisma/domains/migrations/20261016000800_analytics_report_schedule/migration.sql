-- F-1006-a: a person's scheduled analytics report (ADR-0150 (3), (4)).
-- Additive: two enums, one table. Not derived from any ledger: a rebuild
-- never touches it.

CREATE TYPE "billing"."AnalyticsReportFrequency" AS ENUM ('daily', 'weekly', 'monthly');
CREATE TYPE "billing"."AnalyticsReportCalendar" AS ENUM ('jalali', 'gregorian');

CREATE TABLE "billing"."analytics_report_schedule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "frequency" "billing"."AnalyticsReportFrequency" NOT NULL,
    "weekday" SMALLINT,
    "hour" SMALLINT NOT NULL,
    "calendar" "billing"."AnalyticsReportCalendar" NOT NULL,
    "tab" TEXT NOT NULL,
    "bot" BOOLEAN NOT NULL,
    "email" BOOLEAN NOT NULL,
    "pausedAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_report_schedule_pkey" PRIMARY KEY ("id"),
    -- A weekly report names its day, and only a weekly one does.
    CONSTRAINT "analytics_report_schedule_weekday" CHECK (("frequency" = 'weekly') = ("weekday" IS NOT NULL) AND ("weekday" IS NULL OR "weekday" BETWEEN 0 AND 6)),
    CONSTRAINT "analytics_report_schedule_hour" CHECK ("hour" BETWEEN 0 AND 23),
    -- A report goes somewhere: the bot, the email, or both.
    CONSTRAINT "analytics_report_schedule_channel" CHECK ("bot" OR "email")
);

-- The worker's read: what is due, oldest first, paused ones never.
CREATE INDEX "analytics_report_schedule_due_idx" ON "billing"."analytics_report_schedule"("nextRunAt") WHERE "pausedAt" IS NULL;
CREATE INDEX "analytics_report_schedule_person_idx" ON "billing"."analytics_report_schedule"("tenantId", "userId");

-- Strict shape, as `20261016000400_analytics_cost_day`.
ALTER TABLE "billing"."analytics_report_schedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing"."analytics_report_schedule" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing"."analytics_report_schedule"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "billing"."analytics_report_schedule"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."analytics_report_schedule" TO txnet_app, txnet_cross_tenant;
