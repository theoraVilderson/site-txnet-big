-- F-803-a, D-60: a top-up the user pays by moving money themselves (a card,
-- a wallet) is a gateway like any other, of provider `manual_transfer` and
-- category `manual` (billing/contract.manual-transfer.md principle 1).
--
-- Its own migration because Postgres refuses a new enum value inside the
-- transaction that added it, and the next migration's partial index names it.
-- Additive only.

ALTER TYPE "billing"."PaymentProviderName" ADD VALUE 'manual_transfer';

ALTER TYPE "billing"."GatewayCategory" ADD VALUE 'manual';
