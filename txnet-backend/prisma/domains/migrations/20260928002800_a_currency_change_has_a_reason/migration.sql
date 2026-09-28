-- F-116-f (ADR-0098 part 5): the reason a currency change writes on the two
-- ledgers — a wallet's closing and opening row — and the audit action. Alone
-- in its own migration because a value added by `ALTER TYPE ... ADD VALUE`
-- cannot be used in the transaction that adds it, and the next migration's
-- partial index names it.
--
-- Additive. Rollback: none needed (an unused enum value is harmless);
-- Postgres cannot drop one without recreating the type.

ALTER TYPE "billing"."WalletReasonType" ADD VALUE IF NOT EXISTS 'currency_change';
ALTER TYPE "tenant"."TenantBillingReasonType" ADD VALUE IF NOT EXISTS 'currency_change';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'tenant_currency_change';
