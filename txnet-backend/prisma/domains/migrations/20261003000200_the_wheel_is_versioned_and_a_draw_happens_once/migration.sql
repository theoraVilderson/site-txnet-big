-- F-707-a (ADR-0111 points 1, 4, 5). The wheel and the group lottery's tables.
--
-- The wheel: `spin_wheel_config` becomes one **version** of a tenant's wheel —
-- config, eligibility and its prizes fixed once written; an edit is a new
-- version from the next tenant day (TZ-1). The day's cost and each prize's
-- stock are per-day counter rows (`spin_wheel_day`, `spin_wheel_prize_day`)
-- locked `FOR UPDATE` by a spin, so there is no nightly reset and no midnight
-- race: `spin_wheel_prize.currentDayAwardedCount` goes. An awarded spin holds
-- a `seq` unique per (tenant, user, tenant day) — the database keeps the count.
--
-- The lottery: a draw among one governance user group (F-114-j). Frozen after
-- publish; entrants once each; the draw once (its key), its seed sealed
-- (ADR-0022) and made only after the list is fixed; winners and reserves.
--
-- No cash, ever (point 2): `wallet_credit` stays in the enum and a CHECK
-- refuses it on every row; `resultWalletTransactionId` must stay null.
--
-- Additive in effect. The one column dropped and the NOT NULLs added are on
-- tables that have never had a writer: the first statement refuses to run if
-- any of them holds a row, so no data can be lost by it.
-- Rollback: drop the eight new tables, the new columns, the three types and
-- the functions below; restore `currentDayAwardedCount` (INT NOT NULL DEFAULT 0).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "engagement"."spin_wheel_config")
     OR EXISTS (SELECT 1 FROM "engagement"."spin_wheel_prize")
     OR EXISTS (SELECT 1 FROM "engagement"."spin_wheel_attempt") THEN
    RAISE EXCEPTION 'F-707-a expects the spin wheel tables empty: they have never had a writer';
  END IF;
END
$$;

-- CreateEnum
CREATE TYPE "engagement"."LotteryEntryMode" AS ENUM ('automatic', 'opt_in');

-- CreateEnum
CREATE TYPE "engagement"."LotteryStatus" AS ENUM ('draft', 'published', 'frozen', 'drawn', 'cancelled');

-- CreateEnum
CREATE TYPE "engagement"."LotteryWinnerDelivery" AS ENUM ('pending', 'delivered', 'passed_on');

ALTER TYPE "engagement"."SpinPrizeType" ADD VALUE 'extra_days';
ALTER TYPE "engagement"."SpinPrizeType" ADD VALUE 'free_grant';


-- DropForeignKey
ALTER TABLE "engagement"."spin_wheel_prize" DROP CONSTRAINT "spin_wheel_prize_wheelConfigId_fkey";

-- DropIndex
DROP INDEX "engagement"."spin_wheel_config_tenantId_idx";

-- AlterTable
ALTER TABLE "engagement"."spin_wheel_config" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "createdByAdminId" UUID NOT NULL,
ADD COLUMN     "currencyCode" TEXT NOT NULL,
ADD COLUMN     "effectiveFromDay" DATE NOT NULL,
ADD COLUMN     "requiresPhoneVerified" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "userGroupId" UUID,
ADD COLUMN     "version" INTEGER NOT NULL,
ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "engagement"."spin_wheel_prize" DROP COLUMN "currentDayAwardedCount",
ADD COLUMN     "costAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "couponTemplateId" UUID,
ADD COLUMN     "couponValidDays" INTEGER,
ADD COLUMN     "position" INTEGER NOT NULL,
ADD COLUMN     "tenantId" UUID NOT NULL,
ADD COLUMN     "variantId" UUID;

-- AlterTable
ALTER TABLE "engagement"."spin_wheel_attempt" ADD COLUMN     "costAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "currencyCode" TEXT NOT NULL,
ADD COLUMN     "idempotencyKey" TEXT NOT NULL,
ADD COLUMN     "pickedPrizeId" UUID,
ADD COLUMN     "refusalReason" TEXT,
ADD COLUMN     "seq" INTEGER,
ADD COLUMN     "tenantDay" DATE NOT NULL,
ADD COLUMN     "tenantId" UUID NOT NULL,
ADD COLUMN     "wheelConfigId" UUID NOT NULL;

-- CreateTable
CREATE TABLE "engagement"."spin_wheel_day" (
    "tenantId" UUID NOT NULL,
    "tenantDay" DATE NOT NULL,
    "wheelConfigId" UUID NOT NULL,
    "costSpent" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL,
    "spins" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "spin_wheel_day_pkey" PRIMARY KEY ("tenantId","tenantDay")
);

-- CreateTable
CREATE TABLE "engagement"."spin_wheel_prize_day" (
    "prizeId" UUID NOT NULL,
    "tenantDay" DATE NOT NULL,
    "tenantId" UUID NOT NULL,
    "awardedCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "spin_wheel_prize_day_pkey" PRIMARY KEY ("prizeId","tenantDay")
);

-- CreateTable
CREATE TABLE "engagement"."lottery" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userGroupId" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "entryMode" "engagement"."LotteryEntryMode" NOT NULL,
    "status" "engagement"."LotteryStatus" NOT NULL DEFAULT 'draft',
    "closesAt" TIMESTAMP(3) NOT NULL,
    "requiresPhoneVerified" BOOLEAN NOT NULL DEFAULT true,
    "requiresMinAccountAgeHours" INTEGER NOT NULL DEFAULT 24,
    "reservesCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdByAdminId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lottery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement"."lottery_prize" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "lotteryId" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "prizeType" "engagement"."SpinPrizeType" NOT NULL,
    "prizeValue" DECIMAL(18,2) NOT NULL,
    "couponTemplateId" UUID,
    "couponValidDays" INTEGER,
    "variantId" UUID,
    "winnersCount" INTEGER NOT NULL,

    CONSTRAINT "lottery_prize_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement"."lottery_entrant" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "lotteryId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "optedInAt" TIMESTAMP(3),
    "ticketNumber" INTEGER,
    "excludedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lottery_entrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement"."lottery_draw" (
    "lotteryId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "entrantCount" INTEGER NOT NULL,
    "skippedResellerCount" INTEGER NOT NULL DEFAULT 0,
    "listHash" TEXT NOT NULL,
    "seedSealed" JSONB NOT NULL,
    "algorithm" TEXT NOT NULL,
    "frozenAt" TIMESTAMP(3) NOT NULL,
    "drawnAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "lottery_draw_pkey" PRIMARY KEY ("lotteryId")
);

-- CreateTable
CREATE TABLE "engagement"."lottery_winner" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "lotteryId" UUID NOT NULL,
    "entrantId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "prizeId" UUID,
    "delivery" "engagement"."LotteryWinnerDelivery" NOT NULL DEFAULT 'pending',
    "deliveredAt" TIMESTAMP(3),
    "passedOnReason" TEXT,
    "replacesWinnerId" UUID,

    CONSTRAINT "lottery_winner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lottery_tenantId_status_idx" ON "engagement"."lottery"("tenantId", "status");

-- CreateIndex
CREATE INDEX "lottery_status_closesAt_idx" ON "engagement"."lottery"("status", "closesAt");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_id_tenantId_key" ON "engagement"."lottery"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_prize_lotteryId_rank_key" ON "engagement"."lottery_prize"("lotteryId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_prize_id_tenantId_key" ON "engagement"."lottery_prize"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_entrant_lotteryId_userId_key" ON "engagement"."lottery_entrant"("lotteryId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_entrant_lotteryId_ticketNumber_key" ON "engagement"."lottery_entrant"("lotteryId", "ticketNumber");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_entrant_id_tenantId_key" ON "engagement"."lottery_entrant"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_draw_lotteryId_tenantId_key" ON "engagement"."lottery_draw"("lotteryId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_winner_lotteryId_position_key" ON "engagement"."lottery_winner"("lotteryId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "lottery_winner_lotteryId_entrantId_key" ON "engagement"."lottery_winner"("lotteryId", "entrantId");

-- CreateIndex
CREATE INDEX "spin_wheel_config_tenantId_effectiveFromDay_idx" ON "engagement"."spin_wheel_config"("tenantId", "effectiveFromDay");

-- CreateIndex
CREATE UNIQUE INDEX "spin_wheel_config_tenantId_version_key" ON "engagement"."spin_wheel_config"("tenantId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "spin_wheel_config_id_tenantId_key" ON "engagement"."spin_wheel_config"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "spin_wheel_prize_wheelConfigId_position_key" ON "engagement"."spin_wheel_prize"("wheelConfigId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "spin_wheel_prize_id_tenantId_key" ON "engagement"."spin_wheel_prize"("id", "tenantId");

-- CreateIndex
CREATE INDEX "spin_wheel_attempt_tenantId_tenantDay_idx" ON "engagement"."spin_wheel_attempt"("tenantId", "tenantDay");

-- CreateIndex
CREATE UNIQUE INDEX "spin_wheel_attempt_tenantId_userId_tenantDay_seq_key" ON "engagement"."spin_wheel_attempt"("tenantId", "userId", "tenantDay", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "spin_wheel_attempt_tenantId_userId_idempotencyKey_key" ON "engagement"."spin_wheel_attempt"("tenantId", "userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "engagement"."spin_wheel_prize" ADD CONSTRAINT "spin_wheel_prize_wheelConfigId_tenantId_fkey" FOREIGN KEY ("wheelConfigId", "tenantId") REFERENCES "engagement"."spin_wheel_config"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."spin_wheel_day" ADD CONSTRAINT "spin_wheel_day_wheelConfigId_tenantId_fkey" FOREIGN KEY ("wheelConfigId", "tenantId") REFERENCES "engagement"."spin_wheel_config"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."spin_wheel_prize_day" ADD CONSTRAINT "spin_wheel_prize_day_prizeId_tenantId_fkey" FOREIGN KEY ("prizeId", "tenantId") REFERENCES "engagement"."spin_wheel_prize"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."spin_wheel_attempt" ADD CONSTRAINT "spin_wheel_attempt_wheelConfigId_tenantId_fkey" FOREIGN KEY ("wheelConfigId", "tenantId") REFERENCES "engagement"."spin_wheel_config"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."spin_wheel_attempt" ADD CONSTRAINT "spin_wheel_attempt_pickedPrizeId_fkey" FOREIGN KEY ("pickedPrizeId") REFERENCES "engagement"."spin_wheel_prize"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."lottery_prize" ADD CONSTRAINT "lottery_prize_lotteryId_tenantId_fkey" FOREIGN KEY ("lotteryId", "tenantId") REFERENCES "engagement"."lottery"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."lottery_entrant" ADD CONSTRAINT "lottery_entrant_lotteryId_tenantId_fkey" FOREIGN KEY ("lotteryId", "tenantId") REFERENCES "engagement"."lottery"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."lottery_draw" ADD CONSTRAINT "lottery_draw_lotteryId_tenantId_fkey" FOREIGN KEY ("lotteryId", "tenantId") REFERENCES "engagement"."lottery"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."lottery_winner" ADD CONSTRAINT "lottery_winner_lotteryId_tenantId_fkey" FOREIGN KEY ("lotteryId", "tenantId") REFERENCES "engagement"."lottery"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."lottery_winner" ADD CONSTRAINT "lottery_winner_entrantId_tenantId_fkey" FOREIGN KEY ("entrantId", "tenantId") REFERENCES "engagement"."lottery_entrant"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement"."lottery_winner" ADD CONSTRAINT "lottery_winner_prizeId_fkey" FOREIGN KEY ("prizeId") REFERENCES "engagement"."lottery_prize"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- -----------------------------------------------------------------------------
-- Shapes
-- -----------------------------------------------------------------------------

ALTER TABLE "engagement"."spin_wheel_config"
  ADD CONSTRAINT "spin_wheel_config_shape" CHECK (
    "version" >= 1 AND "dailyBudgetCapAmount" >= 0 AND "maxSpinsPerAccountPerDay" >= 1
    AND "perUserCooldownHours" >= 0 AND "requiresMinAccountAgeHours" >= 0
    AND "currencyCode" ~ '^[A-Z]{3}$');

-- What each kind of prize carries (point 2): never cash; GB > 0; whole days;
-- a coupon names its template, a percent in (0, 100] and how long it lives;
-- a free Grant names its variant; an empty slot is free and carries nothing.
-- On `kind::text`: the two values added above are not committed yet inside
-- this migration's transaction, and an enum literal of them would be refused.
CREATE FUNCTION engagement.prize_shape_ok(
  kind "engagement"."SpinPrizeType", amount DECIMAL, template UUID, valid_days INT, variant UUID
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE kind::text
    WHEN 'bonus_traffic_gb' THEN amount > 0 AND template IS NULL AND valid_days IS NULL AND variant IS NULL
    WHEN 'extra_days'       THEN amount >= 1 AND amount = trunc(amount) AND template IS NULL AND valid_days IS NULL AND variant IS NULL
    WHEN 'discount_coupon'  THEN amount > 0 AND amount <= 100 AND template IS NOT NULL AND valid_days >= 1 AND variant IS NULL
    WHEN 'free_grant'       THEN template IS NULL AND valid_days IS NULL AND variant IS NOT NULL
    WHEN 'empty'            THEN amount = 0 AND template IS NULL AND valid_days IS NULL AND variant IS NULL
    ELSE false -- wallet_credit
  END
$$;

ALTER TABLE "engagement"."spin_wheel_prize"
  ADD CONSTRAINT "engagement_prize_shape" CHECK (
    engagement.prize_shape_ok("prizeType", "prizeValue", "couponTemplateId", "couponValidDays", "variantId")
    AND ("prizeType" <> 'empty' OR "costAmount" = 0)
    AND "position" >= 1 AND "probabilityWeight" >= 1 AND "costAmount" >= 0
    AND ("dailyStockLimit" IS NULL OR "dailyStockLimit" >= 0));

ALTER TABLE "engagement"."lottery_prize"
  ADD CONSTRAINT "engagement_prize_shape" CHECK (
    "prizeType" <> 'empty'
    AND engagement.prize_shape_ok("prizeType", "prizeValue", "couponTemplateId", "couponValidDays", "variantId")
    AND "rank" >= 1 AND "winnersCount" >= 1);

ALTER TABLE "engagement"."spin_wheel_day"
  ADD CONSTRAINT "spin_wheel_day_shape" CHECK ("costSpent" >= 0 AND "spins" >= 0 AND "currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "engagement"."spin_wheel_prize_day"
  ADD CONSTRAINT "spin_wheel_prize_day_shape" CHECK ("awardedCount" >= 0);

-- An awarded spin holds a place in the user's day and a reason-free record; a
-- refused one holds neither place nor prize, and says why. Never cash.
ALTER TABLE "engagement"."spin_wheel_attempt"
  ADD CONSTRAINT "spin_wheel_attempt_shape" CHECK (
    ("status" = 'awarded') = ("seq" IS NOT NULL)
    AND ("seq" IS NULL OR "seq" >= 1)
    AND ("status" = 'awarded') = ("refusalReason" IS NULL)
    AND ("status" = 'awarded' OR ("prizeAwardedId" IS NULL AND "costAmount" = 0))
    AND "resultWalletTransactionId" IS NULL
    AND "costAmount" >= 0 AND "currencyCode" ~ '^[A-Z]{3}$'
    AND length("idempotencyKey") BETWEEN 1 AND 128);

ALTER TABLE "engagement"."lottery"
  ADD CONSTRAINT "lottery_shape" CHECK (
    length(btrim("title")) >= 1 AND "reservesCount" >= 0 AND "requiresMinAccountAgeHours" >= 0
    AND ("status" = 'draft' OR "status" = 'cancelled' OR "publishedAt" IS NOT NULL)),
  ADD CONSTRAINT "lottery_cancel_reason" CHECK (
    ("status" = 'cancelled') = ("cancelledAt" IS NOT NULL)
    AND ("status" <> 'cancelled' OR length(btrim(coalesce("cancelReason", ''))) >= 1));

ALTER TABLE "engagement"."lottery_entrant"
  ADD CONSTRAINT "lottery_entrant_shape" CHECK ("ticketNumber" IS NULL OR "ticketNumber" >= 1);
ALTER TABLE "engagement"."lottery_draw"
  ADD CONSTRAINT "lottery_draw_shape" CHECK ("listHash" ~ '^[0-9a-f]{64}$' AND "entrantCount" >= 0 AND "skippedResellerCount" >= 0);
ALTER TABLE "engagement"."lottery_winner"
  ADD CONSTRAINT "lottery_winner_shape" CHECK (
    "position" >= 1
    AND ("delivery" <> 'delivered' OR "deliveredAt" IS NOT NULL)
    AND ("delivery" <> 'passed_on' OR length(btrim(coalesce("passedOnReason", ''))) >= 1));

-- -----------------------------------------------------------------------------
-- Whose a row is. Under RLS another tenant's row is simply not found, so the
-- app pool is refused the same way the owner is.
-- -----------------------------------------------------------------------------

CREATE FUNCTION engagement.same_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ok boolean := true;
BEGIN
  -- One branch per table: plpgsql resolves every `NEW` field an expression
  -- names, so a field another table lacks must sit behind its own IF.
  IF TG_TABLE_NAME IN ('spin_wheel_config', 'lottery') THEN
    IF NEW."userGroupId" IS NOT NULL THEN
      ok := EXISTS (SELECT 1 FROM governance.user_group WHERE id = NEW."userGroupId" AND "tenantId" = NEW."tenantId");
    END IF;
  ELSIF TG_TABLE_NAME = 'lottery_entrant' THEN
    ok := EXISTS (SELECT 1 FROM identity."user" WHERE id = NEW."userId" AND "tenantId" = NEW."tenantId");
  ELSIF TG_TABLE_NAME = 'spin_wheel_attempt' THEN
    -- Its tenant's user, on that user's fingerprint; its prizes are its version's.
    ok := EXISTS (SELECT 1 FROM identity."user" WHERE id = NEW."userId" AND "tenantId" = NEW."tenantId")
      AND EXISTS (SELECT 1 FROM fraud.device_fingerprint
                   WHERE id = NEW."deviceFingerprintId" AND "userId" = NEW."userId" AND "tenantId" = NEW."tenantId")
      AND (NEW."pickedPrizeId" IS NULL OR EXISTS (SELECT 1 FROM engagement.spin_wheel_prize
                   WHERE id = NEW."pickedPrizeId" AND "wheelConfigId" = NEW."wheelConfigId"))
      AND (NEW."prizeAwardedId" IS NULL OR EXISTS (SELECT 1 FROM engagement.spin_wheel_prize
                   WHERE id = NEW."prizeAwardedId" AND "wheelConfigId" = NEW."wheelConfigId"))
      AND EXISTS (SELECT 1 FROM engagement.spin_wheel_config
                   WHERE id = NEW."wheelConfigId" AND "currencyCode" = NEW."currencyCode");
  ELSIF TG_TABLE_NAME = 'spin_wheel_day' THEN
    ok := EXISTS (SELECT 1 FROM engagement.spin_wheel_config
                   WHERE id = NEW."wheelConfigId" AND "currencyCode" = NEW."currencyCode");
  ELSIF TG_TABLE_NAME = 'lottery_winner' THEN
    -- A ticket holder of this lottery; a prize of this lottery.
    ok := EXISTS (SELECT 1 FROM engagement.lottery_entrant
                   WHERE id = NEW."entrantId" AND "lotteryId" = NEW."lotteryId" AND "ticketNumber" IS NOT NULL)
      AND (NEW."prizeId" IS NULL OR EXISTS (SELECT 1 FROM engagement.lottery_prize
                   WHERE id = NEW."prizeId" AND "lotteryId" = NEW."lotteryId"));
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION 'engagement_tenant_mismatch: % % names a row that is not its own', TG_TABLE_NAME, TG_OP
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER spin_wheel_config_same_tenant BEFORE INSERT ON "engagement"."spin_wheel_config"
  FOR EACH ROW EXECUTE FUNCTION engagement.same_tenant();
CREATE TRIGGER spin_wheel_attempt_same_tenant BEFORE INSERT ON "engagement"."spin_wheel_attempt"
  FOR EACH ROW EXECUTE FUNCTION engagement.same_tenant();
CREATE TRIGGER spin_wheel_day_same_tenant BEFORE INSERT OR UPDATE OF "wheelConfigId", "currencyCode" ON "engagement"."spin_wheel_day"
  FOR EACH ROW EXECUTE FUNCTION engagement.same_tenant();
CREATE TRIGGER lottery_same_tenant BEFORE INSERT OR UPDATE OF "userGroupId", "tenantId" ON "engagement"."lottery"
  FOR EACH ROW EXECUTE FUNCTION engagement.same_tenant();
CREATE TRIGGER lottery_entrant_same_tenant BEFORE INSERT OR UPDATE OF "userId", "tenantId" ON "engagement"."lottery_entrant"
  FOR EACH ROW EXECUTE FUNCTION engagement.same_tenant();
CREATE TRIGGER lottery_winner_same_tenant BEFORE INSERT OR UPDATE OF "prizeId", "entrantId" ON "engagement"."lottery_winner"
  FOR EACH ROW EXECUTE FUNCTION engagement.same_tenant();

-- -----------------------------------------------------------------------------
-- A wheel version is fixed once written (point 4)
-- -----------------------------------------------------------------------------
-- Neither a version nor a prize is ever changed or deleted. A prize is written
-- only in the transaction that wrote its version: a slot added to a version
-- already in force would change the odds of a day half spun.

CREATE FUNCTION engagement.spin_wheel_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM engagement.spin_wheel_config
                WHERE id = NEW."wheelConfigId" AND xmin = pg_current_xact_id()::xid) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'spin_wheel_is_history: a prize is written with its version; write a new version'
      USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'spin_wheel_is_history: % is never changed or deleted; write a new version', TG_TABLE_NAME
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER spin_wheel_config_is_history BEFORE UPDATE OR DELETE ON "engagement"."spin_wheel_config"
  FOR EACH ROW EXECUTE FUNCTION engagement.spin_wheel_is_history();
CREATE TRIGGER spin_wheel_prize_is_history BEFORE INSERT OR UPDATE OR DELETE ON "engagement"."spin_wheel_prize"
  FOR EACH ROW EXECUTE FUNCTION engagement.spin_wheel_is_history();

CREATE FUNCTION engagement.spin_wheel_attempt_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'spin_wheel_attempt_is_history: an attempt is written once (invariant 2)'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER spin_wheel_attempt_is_history BEFORE UPDATE OR DELETE ON "engagement"."spin_wheel_attempt"
  FOR EACH ROW EXECUTE FUNCTION engagement.spin_wheel_attempt_is_history();

-- -----------------------------------------------------------------------------
-- The day's cap and each prize's stock, whatever the odds (invariant 1)
-- -----------------------------------------------------------------------------

CREATE FUNCTION engagement.spin_wheel_day_within_limits() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ceiling DECIMAL;
BEGIN
  IF TG_TABLE_NAME = 'spin_wheel_day' THEN
    SELECT "dailyBudgetCapAmount" INTO ceiling FROM engagement.spin_wheel_config WHERE id = NEW."wheelConfigId";
    IF NEW."costSpent" > ceiling THEN
      RAISE EXCEPTION 'spin_wheel_over_cap: % spent of a % cap', NEW."costSpent", ceiling USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "dailyStockLimit" INTO ceiling FROM engagement.spin_wheel_prize WHERE id = NEW."prizeId";
    IF ceiling IS NOT NULL AND NEW."awardedCount" > ceiling THEN
      RAISE EXCEPTION 'spin_wheel_out_of_stock: % awarded of % a day', NEW."awardedCount", ceiling USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER spin_wheel_day_within_cap BEFORE INSERT OR UPDATE ON "engagement"."spin_wheel_day"
  FOR EACH ROW EXECUTE FUNCTION engagement.spin_wheel_day_within_limits();
CREATE TRIGGER spin_wheel_prize_day_within_stock BEFORE INSERT OR UPDATE ON "engagement"."spin_wheel_prize_day"
  FOR EACH ROW EXECUTE FUNCTION engagement.spin_wheel_day_within_limits();

-- -----------------------------------------------------------------------------
-- A lottery: one way, frozen once published, drawn once (point 5)
-- -----------------------------------------------------------------------------

CREATE FUNCTION engagement.lottery_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'draft' THEN
      RAISE EXCEPTION 'lottery_frozen: only a draft lottery is deleted; cancel it with a reason' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'draft'     AND NEW."status" IN ('published', 'cancelled'))
    OR (OLD."status" = 'published' AND NEW."status" IN ('frozen', 'cancelled'))
    OR (OLD."status" = 'frozen'    AND NEW."status" = 'drawn')) THEN
    RAISE EXCEPTION 'lottery_status_one_way: % -> %', OLD."status", NEW."status" USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'draft' AND (NEW."tenantId", NEW."userGroupId", NEW."title", NEW."description", NEW."entryMode", NEW."closesAt",
       NEW."requiresPhoneVerified", NEW."requiresMinAccountAgeHours", NEW."reservesCount", NEW."publishedAt", NEW."createdByAdminId", NEW."createdAt")
     IS DISTINCT FROM (OLD."tenantId", OLD."userGroupId", OLD."title", OLD."description", OLD."entryMode", OLD."closesAt",
       OLD."requiresPhoneVerified", OLD."requiresMinAccountAgeHours", OLD."reservesCount", OLD."publishedAt", OLD."createdByAdminId", OLD."createdAt") THEN
    RAISE EXCEPTION 'lottery_frozen: a published lottery changes only its status' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER lottery_status_one_way BEFORE UPDATE OR DELETE ON "engagement"."lottery"
  FOR EACH ROW EXECUTE FUNCTION engagement.lottery_guard();

-- Prizes change only in a draft. Entrants join and leave only while the
-- lottery is a draft or open; their ticket is set at the freeze, which writes
-- the tickets while the lottery is still `published`, then moves it on.
CREATE FUNCTION engagement.lottery_parts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot_status "engagement"."LotteryStatus";
  lot_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."lotteryId" ELSE NEW."lotteryId" END;
BEGIN
  SELECT "status" INTO lot_status FROM engagement.lottery WHERE id = lot_id;
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; -- the lottery's own delete, cascading
  END IF;
  IF TG_TABLE_NAME = 'lottery_prize' AND lot_status <> 'draft' THEN
    RAISE EXCEPTION 'lottery_frozen: prizes change only in a draft' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'lottery_entrant' THEN
    IF lot_status NOT IN ('draft', 'published') THEN
      RAISE EXCEPTION 'lottery_frozen: the entrant list is fixed at the freeze' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW."id", NEW."tenantId", NEW."lotteryId", NEW."userId", NEW."optedInAt", NEW."createdAt")
         IS DISTINCT FROM (OLD."id", OLD."tenantId", OLD."lotteryId", OLD."userId", OLD."optedInAt", OLD."createdAt") THEN
      RAISE EXCEPTION 'lottery_frozen: an entrant changes only its ticket' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER lottery_prize_frozen BEFORE INSERT OR UPDATE OR DELETE ON "engagement"."lottery_prize"
  FOR EACH ROW EXECUTE FUNCTION engagement.lottery_parts_guard();
CREATE TRIGGER lottery_entrant_frozen BEFORE INSERT OR UPDATE OR DELETE ON "engagement"."lottery_entrant"
  FOR EACH ROW EXECUTE FUNCTION engagement.lottery_parts_guard();

-- The draw is written once (its key is the lottery) by the close job, never
-- deleted; only `publishedAt` is set later, once. A winner row keeps its place.
CREATE FUNCTION engagement.lottery_draw_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'lottery_draw' THEN
    IF TG_OP = 'INSERT' THEN
      IF NOT EXISTS (SELECT 1 FROM engagement.lottery WHERE id = NEW."lotteryId" AND "status" IN ('published', 'frozen')) THEN
        RAISE EXCEPTION 'lottery_draw_is_history: a draw is made at the close of a published lottery' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD."publishedAt" IS NULL AND NEW."publishedAt" IS NOT NULL
       AND (NEW."lotteryId", NEW."tenantId", NEW."entrantCount", NEW."skippedResellerCount", NEW."listHash", NEW."seedSealed",
            NEW."algorithm", NEW."frozenAt", NEW."drawnAt")
       IS NOT DISTINCT FROM (OLD."lotteryId", OLD."tenantId", OLD."entrantCount", OLD."skippedResellerCount", OLD."listHash",
            OLD."seedSealed", OLD."algorithm", OLD."frozenAt", OLD."drawnAt") THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'lottery_draw_is_history: a draw is never changed; only its publishing is recorded, once' USING ERRCODE = '23514';
  END IF;
  -- lottery_winner
  IF TG_OP = 'UPDATE' AND (NEW."id", NEW."tenantId", NEW."lotteryId", NEW."entrantId", NEW."position")
       IS NOT DISTINCT FROM (OLD."id", OLD."tenantId", OLD."lotteryId", OLD."entrantId", OLD."position") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'lottery_draw_is_history: a winner keeps its place in the draw' USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER lottery_draw_is_history BEFORE INSERT OR UPDATE OR DELETE ON "engagement"."lottery_draw"
  FOR EACH ROW EXECUTE FUNCTION engagement.lottery_draw_is_history();
CREATE TRIGGER lottery_winner_is_history BEFORE UPDATE OR DELETE ON "engagement"."lottery_winner"
  FOR EACH ROW EXECUTE FUNCTION engagement.lottery_draw_is_history();

-- -----------------------------------------------------------------------------
-- Row-Level Security: strict, every table (`spin_wheel_config` has it since
-- 20260909001500). A wheel or a lottery is one tenant's, never shared-read.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'engagement.spin_wheel_prize',
    'engagement.spin_wheel_day',
    'engagement.spin_wheel_prize_day',
    'engagement.spin_wheel_attempt',
    'engagement.lottery',
    'engagement.lottery_prize',
    'engagement.lottery_entrant',
    'engagement.lottery_draw',
    'engagement.lottery_winner'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);
    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END
$$;
