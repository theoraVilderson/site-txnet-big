-- Every quoted price records the rate snapshot it was priced at (F-0606-b,
-- ADR-0019). `exchangeRateSnapshot` already holds the rate; it does not say
-- *which* reading that was, and the FX worker (F-0606-a) appends a
-- `currency_exchange_rate` row on every accepted poll, so the number alone
-- cannot identify one. This column is the id of that row.
--
-- A real foreign key, not a loose uuid: the point of the column is to be
-- evidence, and evidence that can dangle is not evidence. ON DELETE RESTRICT
-- for the reason the gateway columns have it — a payment is a permanent record.
-- The rate table is append-only (`contract.fx-worker.md` invariant 3), so
-- nothing should ever hit the restriction.
--
-- Nullable, and stays null for now: nothing writes it until F-092-c reads the
-- cached snapshot and F-092-i persists the intent. It is also null forever on a
-- gateway that prices from its own `staticRate`, which is a column, not a
-- reading of a market.
--
-- No index on it. The only query that needs one is "which payments used this
-- reading", an audit question, and the rows that will carry a value are a
-- fraction of the table; the RESTRICT check is the same rare path. Add a
-- partial index when something actually asks.
--
-- Rollback: ALTER TABLE "billing"."payment_transaction"
--   DROP CONSTRAINT "payment_transaction_exchangeRateSnapshotId_fkey",
--   DROP COLUMN "exchangeRateSnapshotId";

-- AlterTable
ALTER TABLE "billing"."payment_transaction" ADD COLUMN "exchangeRateSnapshotId" UUID;

-- AddForeignKey
ALTER TABLE "billing"."payment_transaction"
  ADD CONSTRAINT "payment_transaction_exchangeRateSnapshotId_fkey"
  FOREIGN KEY ("exchangeRateSnapshotId")
  REFERENCES "currency"."currency_exchange_rate"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
