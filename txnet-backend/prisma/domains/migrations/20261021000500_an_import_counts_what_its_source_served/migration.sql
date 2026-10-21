-- F-208 (D-63): an imported Grant starts with what its source panel served.
--
--   grant.importedUsedBytes — the client's upload plus download at the source
--                    when it was imported, counted in Used beside the
--                    configs' lifetime counters (network `contract.lease.md`),
--                    so the first plan leaves the bag less it and not the
--                    whole bag again. Written once by the commit (F-207),
--                    never moved; 0 on every Grant that is not a `migration`
--                    one (CHECK). No ledger entry and no hold: the bytes were
--                    served and paid for at the source.
--   MigrationSkipReason.traffic_mismatch — an unlimited client on a limited
--                    product or the other way round, reported by the dry run
--                    instead of failed at the commit.
--
-- Additive; rollback: drop the CHECK and the column (the enum value stays:
-- Postgres cannot drop one, and an unused value is harmless).

ALTER TYPE "entitlement"."MigrationSkipReason" ADD VALUE 'traffic_mismatch';

ALTER TABLE "entitlement"."grant" ADD COLUMN "importedUsedBytes" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "entitlement"."grant" ADD CONSTRAINT "grant_imported_used_bytes_shape"
  CHECK ("importedUsedBytes" >= 0 AND ("importedUsedBytes" = 0 OR "source" = 'migration'));
