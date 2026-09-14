-- A gateway may leave either end of its amount range open (the user's call,
-- 2026-09-14): NULL is no limit on that side. `priceAtGateway` skips a missing
-- bound and takes no gap without a minimum.
--
-- Existing rows keep their values; nothing is backfilled.
--
-- Rollback: set a value on every NULL row, then `SET NOT NULL` again.

-- AlterTable
ALTER TABLE "billing"."payment_gateway" ALTER COLUMN "minAcceptAmount" DROP NOT NULL,
ALTER COLUMN "maxAcceptAmount" DROP NOT NULL;

-- AlterTable
ALTER TABLE "tenant"."tenant_gateway_config" ALTER COLUMN "minAcceptAmount" DROP NOT NULL,
ALTER COLUMN "maxAcceptAmount" DROP NOT NULL;
