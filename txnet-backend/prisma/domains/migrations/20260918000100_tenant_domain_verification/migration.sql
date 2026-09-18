-- F-018-i — a reseller proves a custom domain (catalog 13.2 steps 1-3 and 6).
--
-- 1. The status `verifying`: the tenant says its TXT record is in place and the
--    sweep checks it. Like `pending`, it does not route.
-- 2. What the sweep keeps per row: when the status last changed, the last check
--    and what it expected and found, the last re-validation, and
--    `revalidatingSince` — a `verified` domain whose record is missing, still
--    routed until the grace ends.
--
-- Rollback: drop the columns. The enum value stays (Postgres cannot drop one);
-- move any `verifying` row back to `pending` first.

ALTER TYPE "tenant"."DomainVerificationStatus" ADD VALUE IF NOT EXISTS 'verifying' BEFORE 'verified';

ALTER TABLE "tenant"."tenant_domain"
  ADD COLUMN "statusChangedAt" TIMESTAMP(3),
  ADD COLUMN "lastCheckedAt" TIMESTAMP(3),
  ADD COLUMN "lastCheck" JSONB,
  ADD COLUMN "lastRevalidatedAt" TIMESTAMP(3),
  ADD COLUMN "revalidatingSince" TIMESTAMP(3);
