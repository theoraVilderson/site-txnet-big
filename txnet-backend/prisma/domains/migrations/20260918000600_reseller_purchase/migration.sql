-- F-019-h — a platform user buys a reseller package (ADR-0061). No table
-- changes: the purchase debits the buyer's `wallet_transaction` and credits the
-- new reseller's `tenant_billing_transaction`, each under a reason of its own.
--
-- Rollback: none needed; Postgres cannot drop an enum value, it stays unused.

ALTER TYPE "billing"."WalletReasonType" ADD VALUE IF NOT EXISTS 'reseller_purchase';
ALTER TYPE "tenant"."TenantBillingReasonType" ADD VALUE IF NOT EXISTS 'reseller_purchase';
