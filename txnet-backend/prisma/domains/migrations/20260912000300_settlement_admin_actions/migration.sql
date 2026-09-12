-- F-096-e (ADR-0041 §5, §6) — the operator surface over granted gateways is
-- audited like every other admin action, so `admin_audit_log` needs the three
-- acts it performs and the two things those acts point at.
--
-- Enum values only. The three settlement tables themselves landed with F-096-a
-- (`20260912000200_gateway_grant_and_settlement`) and are unchanged here: what
-- this row adds is code, not storage.
--
-- Three actions rather than reusing `tenant_settlement_approve`, because the
-- trail exists to answer "who let this tenant collect, and who stopped it" —
-- a single value cannot tell a grant from its withdrawal, and the withdrawal
-- is the one with a `withdrawnByAdminId` beside it to be reconciled against.
--
-- Rollback: none possible, and none needed. Postgres cannot drop an enum
-- value; an unused one is inert, exactly as `catalog."DiscountType"`'s
-- `wallet_credit` is in `20260911000000_payment_legacy_port`.

-- AlterEnum
ALTER TYPE "audit"."AdminAction" ADD VALUE 'gateway_grant_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'gateway_grant_withdraw';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'gateway_settlement_payout';

-- AlterEnum
ALTER TYPE "audit"."AuditTargetType" ADD VALUE 'gateway_grant';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE 'settlement_payout';
