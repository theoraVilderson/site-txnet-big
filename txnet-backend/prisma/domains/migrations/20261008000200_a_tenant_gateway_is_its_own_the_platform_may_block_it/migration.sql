-- F-104-ak: a tenant's gateway is offered as soon as it is switched on; the
-- platform owner's lever is a block, with a reason. Additive only: the retired
-- `verificationStatus` column stays until a migration of its own drops it.
ALTER TABLE "tenant"."tenant_gateway_config"
  ADD COLUMN "blockedAt" TIMESTAMP(3),
  ADD COLUMN "blockedReason" TEXT,
  ADD COLUMN "blockedByAdminId" UUID;
