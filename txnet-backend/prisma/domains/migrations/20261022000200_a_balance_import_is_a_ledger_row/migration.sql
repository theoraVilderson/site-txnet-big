-- F-209-a (catalog §16): a reseller's balances brought from its old panel, from
-- a file. Each row is a ledger credit of its own reason, never an UPDATE on a
-- balance; the dry run names why a row is not imported.
-- Additive: new enum values only. The index that uses the new reason is the
-- next migration's — a value added in a transaction cannot be used in it.

ALTER TYPE "billing"."WalletReasonType" ADD VALUE 'migration_import';

ALTER TYPE "entitlement"."MigrationSkipReason" ADD VALUE 'unknown_user';
ALTER TYPE "entitlement"."MigrationSkipReason" ADD VALUE 'ambiguous_user';
ALTER TYPE "entitlement"."MigrationSkipReason" ADD VALUE 'currency_mismatch';
