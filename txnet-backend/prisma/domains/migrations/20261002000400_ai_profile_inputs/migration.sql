-- F-038-c (ADR-0109 points 6, 7, 14; user 2026-10-02): what the hourly
-- profile builder reads that F-038-b's reader could not.
--
-- 1. `ai.meter_reading` — the engine's own hourly sample of every Grant's
--    counters. It reads no network table (point 6), so F-602's rate, which
--    sums `network.traffic_raw_log`, is not open to it: it samples
--    `grant.consumedBytes` and `grant_meter.consumed` instead and keeps the
--    growth per hour, 180 days (point 14). Strict RLS, as every `ai` table.
--
-- 2. Three views for the tables keyed by user with no `tenantId`
--    (`identity.session`, `notification.notification`, `billing.wallet`).
--    Those tables have no RLS, so a reader policy on them would be inert, and
--    turning RLS on would change three other units' tables for every role.
--    Each view instead holds the same rule a policy would — the row's user
--    belongs to the bound tenant (`public.current_tenant_id()`, NULL unbound =
--    no rows) — and only the columns the engine needs: no IP, user agent,
--    token hash, notice title or body. `security_barrier`, so no predicate of
--    the caller's runs before the tenant clause. Readable by
--    `txnet_ai_reader` alone; the schema's default grants to the app roles
--    are revoked. `ai-service/src/app/reader/reader-role.spec.ts` asserts all
--    of it.
--
-- Additive. Rollback: DROP VIEW ai.reader_sign_in, ai.reader_notice,
-- ai.reader_wallet; DROP TABLE ai.meter_reading.

CREATE TABLE "ai"."meter_reading" (
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "meterKey" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "counter" BIGINT NOT NULL,
    "delta" BIGINT NOT NULL,

    CONSTRAINT "meter_reading_pkey" PRIMARY KEY ("tenantId","grantId","meterKey","hour")
);

CREATE INDEX "meter_reading_tenantId_userId_hour_idx" ON "ai"."meter_reading"("tenantId", "userId", "hour");
CREATE INDEX "meter_reading_tenantId_hour_idx" ON "ai"."meter_reading"("tenantId", "hour");

ALTER TABLE "ai"."meter_reading" ADD CONSTRAINT "meter_reading_delta_not_negative" CHECK ("delta" >= 0 AND "counter" >= 0);

ALTER TABLE ai.meter_reading ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.meter_reading FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai.meter_reading
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON ai.meter_reading
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

-- The reader's views ---------------------------------------------------------

CREATE VIEW ai.reader_sign_in WITH (security_barrier) AS
  SELECT s."userId", s."issuedAt", s."deviceLabel"
  FROM identity.session s
  JOIN identity."user" u ON u."id" = s."userId"
  WHERE u."tenantId" = public.current_tenant_id()
    AND NOT s."isImpersonated";

CREATE VIEW ai.reader_notice WITH (security_barrier) AS
  SELECT n."userId", n."type", n."createdAt", n."readAt"
  FROM notification.notification n
  JOIN identity."user" u ON u."id" = n."userId"
  WHERE u."tenantId" = public.current_tenant_id();

CREATE VIEW ai.reader_wallet WITH (security_barrier) AS
  SELECT w."id", w."ownerUserId" AS "userId", w."cachedBalance", w."heldAmount", w."currencyCode"
  FROM billing.wallet w
  JOIN identity."user" u ON u."id" = w."ownerUserId"
  WHERE u."tenantId" = public.current_tenant_id();

REVOKE ALL ON ai.reader_sign_in, ai.reader_notice, ai.reader_wallet FROM PUBLIC, txnet_app, txnet_cross_tenant;
GRANT USAGE ON SCHEMA ai TO txnet_ai_reader;
GRANT SELECT ON ai.reader_sign_in TO txnet_ai_reader;
GRANT SELECT ON ai.reader_notice TO txnet_ai_reader;
GRANT SELECT ON ai.reader_wallet TO txnet_ai_reader;
