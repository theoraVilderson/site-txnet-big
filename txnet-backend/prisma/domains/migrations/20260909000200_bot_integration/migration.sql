-- Several bots per tenant, with roles (catalog 10.1 / C-05 — F-315, F-316).
-- `automation.bot_integration` replaces `tenant.tenant_bot_integration`.
--
-- Destructive, and safe to be: `tenant_bot_integration` has never been
-- written. It was created empty by `20260908000000_init` and no service, job
-- or seed has ever read or set it, so there is nothing to expand-backfill-
-- contract over and no rollback plan beyond re-running init's DDL.
--
-- Two columns are gone rather than moved. `botTokenEncrypted` becomes a vault
-- reference (ADR-0026, F-316): `credentialRef` is the `label` half of a
-- `CredentialRef`, and the tenant and the kind come from this row's own
-- `tenantId` and `platform`. The webhook secret takes the same label under
-- kind `webhook_secret`, so rotating it keeps an in-flight update verifiable
-- through the grace window ADR-0026 decision 4 requires.
--
-- `isActive` becomes `status`, because "not running" now has causes worth
-- telling apart: never provisioned, switched off by a human, or refused
-- upstream. `lastErrorAt` is only meaningful next to the third.

-- CreateEnum
CREATE TYPE "automation"."BotRole" AS ENUM ('primary', 'sales', 'support', 'secondary');

-- CreateEnum
CREATE TYPE "automation"."BotIntegrationStatus" AS ENUM ('pending', 'active', 'disabled', 'error');

-- CreateTable
CREATE TABLE "automation"."bot_integration" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "platform" "identity"."SocialPlatform" NOT NULL,
    "botUsername" TEXT NOT NULL,
    "role" "automation"."BotRole" NOT NULL DEFAULT 'primary',
    "credentialRef" TEXT NOT NULL,
    "webhookPath" TEXT NOT NULL,
    "status" "automation"."BotIntegrationStatus" NOT NULL DEFAULT 'pending',
    "lastErrorAt" TIMESTAMP(3),
    "capabilities" JSONB,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_integration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_integration_webhookPath_key" ON "automation"."bot_integration"("webhookPath");

-- CreateIndex
CREATE INDEX "bot_integration_tenantId_status_idx" ON "automation"."bot_integration"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bot_integration_tenantId_platform_botUsername_key" ON "automation"."bot_integration"("tenantId", "platform", "botUsername");

-- DropTable
DROP TABLE "tenant"."tenant_bot_integration";

-- Section 99 — the partial unique index the catalog block asks for.
--
-- Prisma cannot express `where`, and this constraint is the whole of C-05:
-- one bot per tenant and platform carries OTP and transactional alerts, and
-- which one it is has to be a fact the database holds, not a rule a service
-- remembers. Two `primary` rows would make "send this tenant's OTP" pick
-- whichever the planner found first — the same failure the vault's
-- `one_active_per_kind_label` index exists to prevent.
CREATE UNIQUE INDEX "bot_integration_one_primary_per_tenant_platform"
    ON "automation"."bot_integration" ("tenantId", "platform")
 WHERE "role" = 'primary';
