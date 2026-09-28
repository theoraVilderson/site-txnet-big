-- F-311-k: an admin resets a prepaid Grant's traffic. The meter is never
-- rewritten (user, 2026-09-26): Quota rises by what was used, as a
-- `quota_adjustment` row. This column is Used at the last reset, so a second
-- reset adds only what was used since the first. 0 = never reset.
--
-- Additive; rollback: ALTER TABLE "entitlement"."grant" DROP COLUMN "trafficResetFromBytes".

ALTER TABLE "entitlement"."grant" ADD COLUMN "trafficResetFromBytes" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "entitlement"."grant" ADD CONSTRAINT "grant_traffic_reset_from_bytes_not_negative" CHECK ("trafficResetFromBytes" >= 0);
