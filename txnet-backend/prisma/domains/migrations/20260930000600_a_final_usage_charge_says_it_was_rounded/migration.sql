-- F-118-am (user 2026-09-30): the wallet line of a closed Grant's last capture
-- says it was rounded up to a cent (F-118-al), with the usage it covers, so a
-- one-cent charge on a closed service reads as what it is.
--
-- `wallet_transaction` had no way to say more than its `reasonType`:
--   "meterKey" + "usageQuantity" — the meter and the units a postpaid capture
--       paid for (bytes on `vpn.traffic`). Both or neither; a positive count.
--   "note" — a closed set of facts about the row. The first is
--       `final_usage_rounded_up`, only on a `usage_charge` that names its usage.
--
-- Additive, no backfill: rows written before carry nothing and read as before.
-- Rollback: DROP COLUMN "note", "usageQuantity", "meterKey"; DROP TYPE "WalletTransactionNote".

CREATE TYPE "billing"."WalletTransactionNote" AS ENUM ('final_usage_rounded_up');

ALTER TABLE "billing"."wallet_transaction"
    ADD COLUMN "note" "billing"."WalletTransactionNote",
    ADD COLUMN "usageQuantity" BIGINT,
    ADD COLUMN "meterKey" TEXT,
    ADD CONSTRAINT "wallet_transaction_usage_both_or_neither" CHECK (("usageQuantity" IS NULL) = ("meterKey" IS NULL)),
    ADD CONSTRAINT "wallet_transaction_usage_quantity_positive" CHECK ("usageQuantity" IS NULL OR "usageQuantity" > 0),
    ADD CONSTRAINT "wallet_transaction_rounded_note_on_usage" CHECK (
        "note" IS DISTINCT FROM 'final_usage_rounded_up'
        OR ("reasonType" = 'usage_charge' AND "usageQuantity" IS NOT NULL)
    );
