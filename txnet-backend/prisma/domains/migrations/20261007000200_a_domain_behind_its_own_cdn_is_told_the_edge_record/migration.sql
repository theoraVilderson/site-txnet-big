-- EDGE-1-d (ADR-0129 (4)): behind a reseller's own CDN, Cloudflare proves the
-- hostname by a TXT record whose value it issues per registration. Stored so
-- the domain view returns it and the domain check reads it. Additive only.

-- AlterTable
ALTER TABLE "tenant"."tenant_domain" ADD COLUMN     "edgeOwnershipName" TEXT,
ADD COLUMN     "edgeOwnershipValue" TEXT;
