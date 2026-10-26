-- NIN-1-e1, ADR-0165 point 7: a reseller's domain names how it reaches us —
-- our Cloudflare (every existing domain) or its own account at an approved edge.
CREATE TYPE "tenant"."TenantDomainPath" AS ENUM ('platform_cdn', 'own_edge');

ALTER TABLE "tenant"."tenant_domain"
  ADD COLUMN "edgePath" "tenant"."TenantDomainPath" NOT NULL DEFAULT 'platform_cdn',
  ADD COLUMN "pathSwitchedAt" TIMESTAMP(3);
