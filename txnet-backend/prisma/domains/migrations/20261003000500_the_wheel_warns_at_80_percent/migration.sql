-- F-707-e (ADR-0111 point 4). The tenant's admins are told when a day of the
-- wheel has spent 80% of its cap: `capAlertedAt` marks the day told, set by
-- the spin that crosses it under the day row's own `FOR UPDATE` lock, so it
-- is told once.
--
-- Additive. Rollback: ALTER TABLE engagement.spin_wheel_day DROP COLUMN "capAlertedAt".

ALTER TABLE "engagement"."spin_wheel_day" ADD COLUMN "capAlertedAt" TIMESTAMP(3);
