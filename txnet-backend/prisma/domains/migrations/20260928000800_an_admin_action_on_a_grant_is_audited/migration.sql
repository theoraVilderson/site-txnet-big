-- F-311-r — every admin action on a user's Grant or config writes one
-- `admin_audit_log` row (actor, target, before, after, reason), and the Grant
-- answers them as its history.
--
-- Additive only: a nullable column and enum values. Rollback of the column is
-- `DROP COLUMN "reason"`; the enum values cannot be dropped and are inert
-- unused, as in `20260912000300_settlement_admin_actions`.

-- AlterTable
ALTER TABLE "audit"."admin_audit_log" ADD COLUMN "reason" TEXT;

-- AlterEnum
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_freeze';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_unfreeze';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_duration_change';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_traffic_change';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_traffic_reset';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_traffic_gift';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_speed_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_devices_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_delete';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_issue';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_renew';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_link_rotate';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'config_regenerate';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'config_disable';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'config_enable';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'config_retire';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'config_move';

-- AlterEnum
ALTER TYPE "audit"."AuditTargetType" ADD VALUE 'grant';
