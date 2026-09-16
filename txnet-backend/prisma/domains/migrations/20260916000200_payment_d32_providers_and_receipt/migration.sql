-- D-32 (F-104-a): the providers the F-104 series adds, the category of a
-- gateway paid inside a messenger chat, and what a gateway reports actually
-- arrived beside what it was asked to charge.
--
-- `amountReceivedMinor` + `receivedCurrency` are the gateway's receipt, not
-- money of record (C-02 exception, D-32): the wallet is still credited in base
-- currency through `amountCredited`. The currency is stored because a crypto
-- payer may settle in another asset than the invoice named. The amount is in
-- that currency's own minor unit, as `chargedAmountMinor` is in the gateway's.

ALTER TYPE "billing"."PaymentProviderName" ADD VALUE 'oxapay';
ALTER TYPE "billing"."PaymentProviderName" ADD VALUE 'airwallex';
ALTER TYPE "billing"."PaymentProviderName" ADD VALUE 'telegram_stars';
ALTER TYPE "billing"."PaymentProviderName" ADD VALUE 'bale';

ALTER TYPE "billing"."GatewayCategory" ADD VALUE 'in_chat';

ALTER TABLE "billing"."payment_transaction"
  ADD COLUMN "amountReceivedMinor" BIGINT,
  ADD COLUMN "receivedCurrency" TEXT;

-- A receipt is whole or absent: an amount with no currency cannot be converted,
-- and a currency with no amount says nothing arrived.
ALTER TABLE "billing"."payment_transaction"
  ADD CONSTRAINT "payment_transaction_receipt_whole"
    CHECK (("amountReceivedMinor" IS NULL) = ("receivedCurrency" IS NULL)),
  ADD CONSTRAINT "payment_transaction_received_non_negative"
    CHECK ("amountReceivedMinor" IS NULL OR "amountReceivedMinor" >= 0),
  ADD CONSTRAINT "payment_transaction_received_currency_code"
    CHECK ("receivedCurrency" IS NULL OR "receivedCurrency" ~ '^[A-Z0-9]{2,20}$');
