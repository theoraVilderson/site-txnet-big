-- Every decryption writes an audit row (ADR-0026 decision 5, catalog 20.4 —
-- F-1215): who, which tenant, which kind, which caller. Never the value.
--
-- Additive only. One table, no foreign keys, and the absence of the keys is
-- the design: an audit trail outlives what it describes. A `RESTRICT` to
-- `tenant_credential` would stop `destroyExpiredVersions` from destroying a
-- superseded version — the one thing ADR-0026 decision 4 requires of it — and
-- a `CASCADE` would erase the record of every use of a credential exactly
-- when it is removed. `audit.admin_audit_log` carries its `tenantId` the same
-- unconstrained way.

-- CreateTable
CREATE TABLE "tenant"."tenant_credential_access" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "kind" "tenant"."TenantCredentialKind" NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL,
    "caller" TEXT NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_credential_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_credential_access_tenantId_createdAt_idx" ON "tenant"."tenant_credential_access"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "tenant_credential_access_credentialId_createdAt_idx" ON "tenant"."tenant_credential_access"("credentialId", "createdAt" DESC);
