-- F-118-n6 (D-58, ADR-0105 decision 10, amended 2026-09-29): on VPN a reseller
-- pays wholesale only for bytes served on platform-owned panels. A reseller's
-- group may mix its own panels with the platform's, and its own cost the
-- platform nothing, so those bytes are counted apart at metering.
--
-- `wholesaleConsumed`: the bytes of a `vpn.traffic` meter's Grant that crossed
-- a platform-owned panel, advanced by `metering-service` in the transaction
-- that moves `grant.consumedBytes`. F-118-n3's wholesale cursor
-- (`wholesaleBilled`) buys against it. Never below zero, and zero on a meter
-- with no wholesale leg (the platform's own Grants).
--
-- No backfill: bytes metered before this carry no panel split and were never
-- billed wholesale (F-118-n3 is not built).
--
-- Additive; rollback: drop the column and its two CHECKs.

ALTER TABLE "entitlement"."grant_meter"
  ADD COLUMN "wholesaleConsumed" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "entitlement"."grant_meter"
  ADD CONSTRAINT "grant_meter_wholesale_consumed_not_negative" CHECK ("wholesaleConsumed" >= 0),
  ADD CONSTRAINT "grant_meter_wholesale_consumed_has_a_leg" CHECK (
    "wholesaleConsumed" = 0 OR "wholesalePayerTenantId" IS NOT NULL);
