-- F-114-a: a job's default schedule is written by worker-service on boot, not
-- by an admin, so `setByAdminId` is null for it. An operator's schedule still
-- carries who set it.
ALTER TABLE "automation"."bot_schedule" ALTER COLUMN "setByAdminId" DROP NOT NULL;
