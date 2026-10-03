-- F-707-i (ADR-0111 point 5). A tenant's Admin drafts, publishes and cancels
-- its lotteries under `engagement.manage` (granted to `Admin` in
-- 20261003000400). The audit trail of each act: on a `lottery`.
--
-- Additive. Rollback: none needed (an enum value cannot be dropped; unused
-- values are harmless).

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'lottery_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'lottery_update';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'lottery_delete';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'lottery_publish';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'lottery_cancel';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'lottery';
