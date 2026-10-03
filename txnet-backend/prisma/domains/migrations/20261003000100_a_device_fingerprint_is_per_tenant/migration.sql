-- F-036-a (D-11, ADR-0111 point 3). The device fingerprint gets its first
-- writer, so it gets what every tenant table has: `tenantId` and Row-Level
-- Security. One row per (tenant, account, fingerprint), its last sighting
-- moved on each record; the 30-day distinct-account count reads
-- (tenantId, fingerprintHash, lastSeenAt). `channel` says which recipe made
-- the hash: web = IP + User-Agent + `device_id` cookie, bot = platform + id.
--
-- The table has had no writer, so it is empty; the backfill from the user's
-- tenant is there only so this never fails on a database where it is not.
--
-- Additive. Rollback: drop the policies, the two indexes, the columns
-- `tenantId` and `channel` and the type; restore the `fingerprintHash` index.

CREATE TYPE "fraud"."FingerprintChannel" AS ENUM ('web', 'bot');

ALTER TABLE "fraud"."device_fingerprint"
  ADD COLUMN "tenantId" UUID,
  ADD COLUMN "channel" "fraud"."FingerprintChannel" NOT NULL DEFAULT 'web',
  ALTER COLUMN "lastSeenAt" SET DEFAULT CURRENT_TIMESTAMP;
UPDATE "fraud"."device_fingerprint" f SET "tenantId" = u."tenantId"
  FROM "identity"."user" u WHERE u."id" = f."userId";
ALTER TABLE "fraud"."device_fingerprint"
  ALTER COLUMN "tenantId" SET NOT NULL,
  ALTER COLUMN "channel" DROP DEFAULT;

DROP INDEX "fraud"."device_fingerprint_fingerprintHash_idx";
CREATE UNIQUE INDEX "device_fingerprint_tenantId_userId_fingerprintHash_key"
  ON "fraud"."device_fingerprint"("tenantId", "userId", "fingerprintHash");
CREATE INDEX "device_fingerprint_tenantId_fingerprintHash_lastSeenAt_idx"
  ON "fraud"."device_fingerprint"("tenantId", "fingerprintHash", "lastSeenAt");

ALTER TABLE "fraud"."device_fingerprint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fraud"."device_fingerprint" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "fraud"."device_fingerprint" TO txnet_app, txnet_cross_tenant;
CREATE POLICY tenant_isolation ON "fraud"."device_fingerprint"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());
CREATE POLICY cross_tenant ON "fraud"."device_fingerprint"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
