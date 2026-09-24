-- F-104-ag — changing a tenant's default tax on a top-up (ADR-0076) is an
-- audited admin action. Its own migration: a value added to an enum cannot be
-- used in the transaction that adds it. The target is the existing `config` value.
--
-- Rollback: none possible, and none needed (see 20260913000200_gateway_admin_actions).

-- AlterEnum
ALTER TYPE "audit"."AdminAction" ADD VALUE 'deposit_tax_update';
