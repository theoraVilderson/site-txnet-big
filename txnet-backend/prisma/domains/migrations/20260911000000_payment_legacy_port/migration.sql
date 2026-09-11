-- The columns the legacy Zarinpal top-up flow needs (F-092-d; D-20, D-21).
--
-- Destructive in two places, and safe to be: `payment_transaction`,
-- `coupon_redemption` and `tenant_gateway_config` have never been written. They
-- were created empty by `20260908000000_init` and no service, job or seed reads
-- or sets them yet. So there is nothing to expand-backfill-contract over, and
-- the NOT NULL columns below carry no default a real row would have needed.
--
--   * `payment_transaction.couponId` goes: codes stack (D-21), so one column
--     cannot hold them. `coupon_redemption.paymentTransactionId` already links
--     every code a payment used.
--   * `coupon_redemption`'s unique (couponId, userId) goes: a per-user limit may
--     exceed 1 (D-21), and is counted in the redemption transaction (F-092-h).
--   * `tenant_gateway_config`'s unique (tenantId) becomes (tenantId,
--     providerName): a reseller may run several gateways (D-20).
--
-- A payment now names either the platform brand's gateway or a reseller's own
-- (ADR-0006), never both and never neither. ADR-0028's key is therefore held
-- once per gateway column. The CHECK at the end is section 99: Prisma cannot
-- express it.
--
-- Rollback, while the tables are still empty: the reverse of each statement
-- below, in reverse order, with `DROP TYPE "billing"."RateRoundingMode"` last.
-- `catalog."DiscountType"` keeps `wallet_credit` — Postgres cannot drop an enum
-- value, and an unused one is harmless.

-- CreateEnum
CREATE TYPE "billing"."RateRoundingMode" AS ENUM ('up', 'nearest');

-- AlterEnum
ALTER TYPE "catalog"."DiscountType" ADD VALUE 'wallet_credit';

-- DropIndex
DROP INDEX "billing"."coupon_redemption_couponId_userId_key";

-- DropIndex
DROP INDEX "tenant"."tenant_gateway_config_tenantId_key";

-- AlterTable
ALTER TABLE "billing"."payment_gateway" ADD COLUMN     "fixedAmountModifier" DECIMAL(18,8) NOT NULL DEFAULT 0,
ADD COLUMN     "maxRate" DECIMAL(18,8),
ADD COLUMN     "minRate" DECIMAL(18,8),
ADD COLUMN     "percentageModifier" DECIMAL(9,4) NOT NULL DEFAULT 0,
ADD COLUMN     "roundingMode" "billing"."RateRoundingMode" NOT NULL DEFAULT 'up',
ADD COLUMN     "roundingStep" DECIMAL(18,8),
ADD COLUMN     "staticRate" DECIMAL(18,8),
ADD COLUMN     "useLiveRate" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "billing"."payment_transaction" DROP COLUMN "couponId",
ADD COLUMN     "amountCredited" DECIMAL(18,2) NOT NULL,
ADD COLUMN     "cardPanMasked" TEXT,
ADD COLUMN     "chargedAmountMinor" BIGINT NOT NULL,
ADD COLUMN     "discountApplied" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "exchangeRateSnapshot" DECIMAL(18,8),
ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "gatewayReferenceId" TEXT,
ADD COLUMN     "taxApplied" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "tenantGatewayConfigId" UUID,
ALTER COLUMN "gatewayId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "tenant"."tenant_gateway_config" ADD COLUMN     "displayName" TEXT NOT NULL,
ADD COLUMN     "feeCalculationMode" "billing"."FeeCalcMode" NOT NULL,
ADD COLUMN     "feeCeiling" DECIMAL(18,2),
ADD COLUMN     "feeFloor" DECIMAL(18,2),
ADD COLUMN     "feeType" "billing"."FeeType" NOT NULL,
ADD COLUMN     "feeValue" DECIMAL(18,4) NOT NULL,
ADD COLUMN     "fixedAmountModifier" DECIMAL(18,8) NOT NULL DEFAULT 0,
ADD COLUMN     "maxAcceptAmount" DECIMAL(18,2) NOT NULL,
ADD COLUMN     "maxRate" DECIMAL(18,8),
ADD COLUMN     "minAcceptAmount" DECIMAL(18,2) NOT NULL,
ADD COLUMN     "minRate" DECIMAL(18,8),
ADD COLUMN     "percentageModifier" DECIMAL(9,4) NOT NULL DEFAULT 0,
ADD COLUMN     "roundingMode" "billing"."RateRoundingMode" NOT NULL DEFAULT 'up',
ADD COLUMN     "roundingStep" DECIMAL(18,8),
ADD COLUMN     "staticRate" DECIMAL(18,8),
ADD COLUMN     "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 10,
ADD COLUMN     "useLiveRate" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "coupon_redemption_couponId_userId_idx" ON "billing"."coupon_redemption"("couponId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transaction_gatewayId_gatewayTrackingCode_key" ON "billing"."payment_transaction"("gatewayId", "gatewayTrackingCode");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transaction_tenantGatewayConfigId_gatewayTrackingCo_key" ON "billing"."payment_transaction"("tenantGatewayConfigId", "gatewayTrackingCode");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_gateway_config_tenantId_providerName_key" ON "tenant"."tenant_gateway_config"("tenantId", "providerName");

-- AddForeignKey
ALTER TABLE "billing"."payment_transaction" ADD CONSTRAINT "payment_transaction_tenantGatewayConfigId_fkey" FOREIGN KEY ("tenantGatewayConfigId") REFERENCES "tenant"."tenant_gateway_config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Section 99 — hand-written. A payment names exactly one gateway.
ALTER TABLE "billing"."payment_transaction" ADD CONSTRAINT "payment_transaction_exactly_one_gateway"
  CHECK (num_nonnulls("gatewayId", "tenantGatewayConfigId") = 1);
