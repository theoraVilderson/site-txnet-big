-- F-116-b (ADR-0098 parts 2-3, amends ADR-0002) — every money row records its
-- currency code.
--
-- A tenant's operating currency can change (F-116-f), so a row's currency can
-- never be derived from its tenant: each row says what its amounts are in.
-- Every existing row is backfilled `USD`, which is what ADR-0019 made them.
--
-- The default is dropped once the backfill is done: a writer that does not say
-- which currency it wrote is refused by NOT NULL, not quietly labelled USD
-- ("a money column whose currency is implied" is foreclosed by ADR-0098).
--
-- No FK to `currency.currency(code)`, for the reason F-116-a gives: those rows
-- are seeded, not migrated. A CHECK holds the shape.
--
-- Rollback: drop the trigger and its function, then each column (its CHECK
-- goes with it).

ALTER TABLE "billing"."wallet"
    ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "wallet_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "billing"."wallet" ALTER COLUMN "currencyCode" DROP DEFAULT;

ALTER TABLE "billing"."wallet_transaction"
    ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "wallet_transaction_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "billing"."wallet_transaction" ALTER COLUMN "currencyCode" DROP DEFAULT;

ALTER TABLE "billing"."invoice"
    ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "invoice_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "billing"."invoice" ALTER COLUMN "currencyCode" DROP DEFAULT;

ALTER TABLE "billing"."payment_transaction"
    ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "payment_transaction_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "billing"."payment_transaction" ALTER COLUMN "currencyCode" DROP DEFAULT;

ALTER TABLE "billing"."coupon"
    ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "coupon_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "billing"."coupon" ALTER COLUMN "currencyCode" DROP DEFAULT;

ALTER TABLE "billing"."discount_rule"
    ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "discount_rule_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "billing"."discount_rule" ALTER COLUMN "currencyCode" DROP DEFAULT;

ALTER TABLE "billing"."deposit_setting"
    ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "deposit_setting_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "billing"."deposit_setting" ALTER COLUMN "currencyCode" DROP DEFAULT;

ALTER TABLE "billing"."gateway_settlement_entry"
    ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "gateway_settlement_entry_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "billing"."gateway_settlement_entry" ALTER COLUMN "currencyCode" DROP DEFAULT;

ALTER TABLE "billing"."gateway_settlement_payout"
    ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "gateway_settlement_payout_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "billing"."gateway_settlement_payout" ALTER COLUMN "currencyCode" DROP DEFAULT;

ALTER TABLE "billing"."payment_gateway"
    ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "payment_gateway_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "billing"."payment_gateway" ALTER COLUMN "currencyCode" DROP DEFAULT;

ALTER TABLE "tenant"."tenant_gateway_config"
    ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    ADD CONSTRAINT "tenant_gateway_config_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "tenant"."tenant_gateway_config" ALTER COLUMN "currencyCode" DROP DEFAULT;

-- The ledger refuses a row whose currency is not its wallet's (ADR-0098 part 3).
-- `WalletLedgerService` checks first and names the refusal; this is the same
-- rule for every other way a row could be inserted. Checked against the
-- wallet's currency **now**, not a foreign key to it: F-116-f closes a wallet
-- in one currency and reopens it in another, and the rows written before stay
-- in the currency they were written in.
CREATE FUNCTION billing.wallet_transaction_in_wallet_currency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  wallet_currency TEXT;
BEGIN
  SELECT "currencyCode" INTO wallet_currency FROM billing.wallet WHERE id = NEW."walletId";
  IF wallet_currency IS DISTINCT FROM NEW."currencyCode" THEN
    RAISE EXCEPTION 'wallet_transaction in % for wallet % kept in %', NEW."currencyCode", NEW."walletId", wallet_currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_transaction_in_wallet_currency
  BEFORE INSERT ON billing.wallet_transaction
  FOR EACH ROW EXECUTE FUNCTION billing.wallet_transaction_in_wallet_currency();
