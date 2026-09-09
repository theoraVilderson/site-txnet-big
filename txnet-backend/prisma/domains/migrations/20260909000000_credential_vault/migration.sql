-- The Credential Vault (ADR-0026, catalog 20.4).
--
-- Envelope encryption: one DEK per tenant in `tenant_dek`, wrapped by a KEK
-- read from a mounted Docker Swarm secret; every credential version in
-- `tenant_credential` is AES-256-GCM under that DEK, with its own IV and its
-- auth tag stored beside it.
--
-- Additive only. No existing table is touched and nothing is backfilled: the
-- four `*Encrypted` columns on `tenant_gateway_config`, `tenant_sms_config`
-- and `tenant_bot_integration` are still there and still empty — nothing has
-- ever written them. They are retired by F-066-h, which replaces
-- `tenant_bot_integration` outright, and by F-018 for the other two.

-- CreateEnum
-- CreateEnum
CREATE TYPE "tenant"."TenantCredentialKind" AS ENUM ('telegram_bot_token', 'bale_bot_token', 'sms_api_key', 'sms_sender_line', 'gateway_merchant_id', 'gateway_secret_key', 'panel_credentials', 'webhook_secret', 'ai_provider_api_key', 'source_panel_credentials', 'cdn_dns_credentials');

-- CreateEnum
CREATE TYPE "tenant"."TenantCredentialStatus" AS ENUM ('active', 'superseded', 'expired', 'revoked');

-- CreateTable
CREATE TABLE "tenant"."tenant_dek" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "kekId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "tenant_dek_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tenant_credential" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "tenant"."TenantCredentialKind" NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "dekId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "tenant"."TenantCredentialStatus" NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "tenant_credential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_dek_tenantId_retiredAt_idx" ON "tenant"."tenant_dek"("tenantId", "retiredAt");

-- CreateIndex
CREATE INDEX "tenant_credential_tenantId_kind_status_idx" ON "tenant"."tenant_credential"("tenantId", "kind", "status");

-- CreateIndex
CREATE INDEX "tenant_credential_status_rotatedAt_idx" ON "tenant"."tenant_credential"("status", "rotatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_credential_tenantId_kind_label_version_key" ON "tenant"."tenant_credential"("tenantId", "kind", "label", "version");

-- AddForeignKey
ALTER TABLE "tenant"."tenant_dek" ADD CONSTRAINT "tenant_dek_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_credential" ADD CONSTRAINT "tenant_credential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tenant_credential" ADD CONSTRAINT "tenant_credential_dekId_fkey" FOREIGN KEY ("dekId") REFERENCES "tenant"."tenant_dek"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Section 99: what Prisma cannot express ────────────────────────────────
--
-- At most ONE `active` version of a credential per (tenantId, kind, label).
-- This is a *partial* unique index — the older `superseded` versions are the
-- whole point of the rotation grace window (ADR-0026 decision 4), so the
-- constraint cannot be a plain `@@unique` over those three columns.
--
-- It is written here rather than deferred to F-041 because the vault reads
-- "the active version" as a single row: without this index a failed rotation
-- could leave two, and the read would return whichever the planner found
-- first. Hand-written SQL living in the same migration history is the shape
-- `docs/operations/migrations.md` settled on for D-5.
CREATE UNIQUE INDEX "tenant_credential_one_active_per_kind_label"
    ON "tenant"."tenant_credential" ("tenantId", "kind", "label")
 WHERE "status" = 'active';
