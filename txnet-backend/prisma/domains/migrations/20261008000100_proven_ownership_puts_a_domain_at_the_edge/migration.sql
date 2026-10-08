-- EDGE-1-n, ADR-0129 amendment 3: a `verifying` domain whose TXT and CNAME pass
-- is held at the edge, so its certificate issues before the probe lines run.
ALTER TABLE "tenant"."tenant_domain" ADD COLUMN "ownershipProvenAt" TIMESTAMP(3);
