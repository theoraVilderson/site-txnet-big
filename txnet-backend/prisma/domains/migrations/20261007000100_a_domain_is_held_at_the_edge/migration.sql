-- EDGE-1-b (ADR-0129 (5, 6)): a custom domain is a custom hostname at a CDN,
-- which issues its certificate. `arvanRegisteredAt` was never written (0 non-null
-- rows on dev, 2026-10-07) and is replaced by these columns.

-- CreateEnum
CREATE TYPE "tenant"."TenantDomainEdgeProvider" AS ENUM ('cloudflare');

-- CreateEnum
CREATE TYPE "tenant"."TenantDomainEdgeStatus" AS ENUM ('none', 'registering', 'issuing', 'issued', 'renew_failed', 'failed');

-- AlterTable
ALTER TABLE "tenant"."tenant_domain" DROP COLUMN "arvanRegisteredAt",
ADD COLUMN     "edgeProvider" "tenant"."TenantDomainEdgeProvider",
ADD COLUMN     "edgeHostnameId" TEXT,
ADD COLUMN     "edgeStatus" "tenant"."TenantDomainEdgeStatus" NOT NULL DEFAULT 'none',
ADD COLUMN     "edgeCheckedAt" TIMESTAMP(3),
ADD COLUMN     "edgeLastError" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domain_edgeProvider_edgeHostnameId_key" ON "tenant"."tenant_domain"("edgeProvider", "edgeHostnameId");
