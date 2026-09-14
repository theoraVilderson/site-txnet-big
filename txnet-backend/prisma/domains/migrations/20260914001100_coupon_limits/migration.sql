-- F-502-j (D-33) — the storage for the limits a coupon did not have: a start
-- date, weekday and hour windows, a maximum purchase, first purchase / new user
-- only, a per-user limit per period, the channels and the gateways it works on.
-- Catalog §4.7 names `validFrom` and `firstPurchaseOnly`; the rest are the
-- user's. Additive: every column defaults to "no limit", so every existing
-- coupon behaves exactly as before. Nothing reads them until F-502-k.
--
-- A CHECK that evaluates to NULL passes, so every "both or neither" spells
-- its IS NOT NULLs out. The CHECKs refuse a limit that cannot mean anything rather than leaving a
-- reader to guess: a half-set window or period, an hour out of range, a
-- maximum below the minimum. The management writer (F-502-c) maps them to its
-- own refusals; the database is the last line.
--
-- Rollback: drop `coupon_gateway`, the new columns and `CouponChannel`.

CREATE TYPE "billing"."CouponChannel" AS ENUM ('panel', 'bot');

ALTER TABLE "billing"."coupon"
  ADD COLUMN "validFrom" TIMESTAMP(3),
  ADD COLUMN "activeWeekdays" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "activeHourFrom" INTEGER,
  ADD COLUMN "activeHourTo" INTEGER,
  ADD COLUMN "maxPurchaseAmount" DECIMAL(18,2),
  ADD COLUMN "firstPurchaseOnly" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "newUserWithinDays" INTEGER,
  ADD COLUMN "periodUsageLimit" INTEGER,
  ADD COLUMN "periodDays" INTEGER,
  ADD COLUMN "allowedChannels" "billing"."CouponChannel"[] NOT NULL DEFAULT ARRAY[]::"billing"."CouponChannel"[];

ALTER TABLE "billing"."coupon"
  -- ISO weekdays, 1 = Monday … 7 = Sunday. `<@` is containment.
  ADD CONSTRAINT "coupon_active_weekdays_iso"
    CHECK ("activeWeekdays" <@ ARRAY[1,2,3,4,5,6,7]),
  -- [from, to): from 0..23, to 1..24, never equal; from > to wraps midnight.
  ADD CONSTRAINT "coupon_active_hours"
    CHECK (("activeHourFrom" IS NULL AND "activeHourTo" IS NULL)
        OR ("activeHourFrom" IS NOT NULL AND "activeHourTo" IS NOT NULL
            AND "activeHourFrom" BETWEEN 0 AND 23 AND "activeHourTo" BETWEEN 1 AND 24
            AND "activeHourFrom" <> "activeHourTo")),
  ADD CONSTRAINT "coupon_max_purchase"
    CHECK ("maxPurchaseAmount" IS NULL
        OR ("maxPurchaseAmount" > 0
            AND ("minPurchaseAmount" IS NULL OR "maxPurchaseAmount" >= "minPurchaseAmount"))),
  ADD CONSTRAINT "coupon_new_user_days"
    CHECK ("newUserWithinDays" IS NULL OR "newUserWithinDays" > 0),
  ADD CONSTRAINT "coupon_period_limit"
    CHECK (("periodUsageLimit" IS NULL AND "periodDays" IS NULL)
        OR ("periodUsageLimit" IS NOT NULL AND "periodDays" IS NOT NULL
            AND "periodUsageLimit" > 0 AND "periodDays" > 0)),
  ADD CONSTRAINT "coupon_valid_window"
    CHECK ("validFrom" IS NULL OR "expiresAt" IS NULL OR "validFrom" < "expiresAt");

-- No `tenantId`: the coupon it hangs off carries the tenant, as
-- `coupon_service_scope` does, and it is read through that coupon.
CREATE TABLE "billing"."coupon_gateway" (
    "id" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "gatewayId" UUID,
    "tenantGatewayConfigId" UUID,

    CONSTRAINT "coupon_gateway_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "coupon_gateway_names_one" CHECK (num_nonnulls("gatewayId", "tenantGatewayConfigId") = 1)
);
CREATE INDEX "coupon_gateway_couponId_idx" ON "billing"."coupon_gateway" ("couponId");
CREATE UNIQUE INDEX "coupon_gateway_platform_once" ON "billing"."coupon_gateway" ("couponId", "gatewayId")
  WHERE "gatewayId" IS NOT NULL;
CREATE UNIQUE INDEX "coupon_gateway_tenant_once" ON "billing"."coupon_gateway" ("couponId", "tenantGatewayConfigId")
  WHERE "tenantGatewayConfigId" IS NOT NULL;
ALTER TABLE "billing"."coupon_gateway" ADD CONSTRAINT "coupon_gateway_couponId_fkey"
  FOREIGN KEY ("couponId") REFERENCES "billing"."coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing"."coupon_gateway" ADD CONSTRAINT "coupon_gateway_gatewayId_fkey"
  FOREIGN KEY ("gatewayId") REFERENCES "billing"."payment_gateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing"."coupon_gateway" ADD CONSTRAINT "coupon_gateway_tenantGatewayConfigId_fkey"
  FOREIGN KEY ("tenantGatewayConfigId") REFERENCES "tenant"."tenant_gateway_config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."coupon_gateway" TO txnet_app, txnet_cross_tenant;
