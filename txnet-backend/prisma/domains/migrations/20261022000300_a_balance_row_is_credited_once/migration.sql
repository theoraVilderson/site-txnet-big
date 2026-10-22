-- F-209-a (C-29): a balance file's row is credited once and taken back once.
-- The commit and the rollback already guard on the item's outcome in the same
-- transaction; this holds it for any other writer of the reason too.
-- Additive: no row of the reason exists before this.

CREATE UNIQUE INDEX "wallet_transaction_migration_import_once"
    ON "billing"."wallet_transaction" ("referenceId", "direction")
    WHERE "reasonType" = 'migration_import';
