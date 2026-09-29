-- F-118-a (D-58, ADR-0105 (6)) — wallet holds: money locked, not spent.
--
-- A hold is not a ledger row. It moves no money; it takes part of a balance
-- out of what any debit may spend, so a postpaid meter, the VPN reserve
-- (F-118-b) and a product purchase cannot all promise the same money. A
-- capture is one ledger debit and the hold reduced by the same amount, in one
-- transaction; a release reduces the hold and moves nothing.
--
-- `CHECK (cachedBalance - heldAmount >= 0)` is the rule, and it binds every
-- writer of the wallet row: a debit path that has never heard of holds is
-- refused by Postgres exactly as `WalletLedgerService` refuses it first.
--
-- `heldAmount` is a cache of the open holds, like `cachedBalance` is of the
-- ledger. A deferred constraint trigger checks at commit that it equals their
-- sum and that every open hold is in its wallet's currency — deferred, because
-- a hold row and its wallet are written by two statements of one transaction,
-- and a currency change converts both.
--
-- Additive: every wallet starts with `heldAmount = 0`, so every debit behaves
-- as before until F-118-b writes the first hold (ADR-0105 (0)).
-- Rollback: drop the triggers and function, the table and its type, then the
-- constraints and the column.

ALTER TABLE "billing"."wallet"
    ADD COLUMN "heldAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;

ALTER TABLE "billing"."wallet"
    ADD CONSTRAINT "wallet_held_amount_non_negative" CHECK ("heldAmount" >= 0),
    ADD CONSTRAINT "wallet_held_within_balance" CHECK ("cachedBalance" - "heldAmount" >= 0);

CREATE TYPE "billing"."WalletHoldStatus" AS ENUM ('open', 'closed');

CREATE TABLE "billing"."wallet_hold" (
    "id" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "ownerRef" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "captured" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "billing"."WalletHoldStatus" NOT NULL DEFAULT 'open',
    "currencyCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "wallet_hold_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "wallet_hold_amount_non_negative" CHECK ("amount" >= 0),
    CONSTRAINT "wallet_hold_captured_non_negative" CHECK ("captured" >= 0),
    CONSTRAINT "wallet_hold_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$'),
    -- Open holds money and has no end; closed holds nothing and says when.
    CONSTRAINT "wallet_hold_closed_is_empty" CHECK (
        ("status" = 'open' AND "closedAt" IS NULL)
        OR ("status" = 'closed' AND "closedAt" IS NOT NULL AND "amount" = 0))
);

CREATE INDEX "wallet_hold_walletId_status_idx" ON "billing"."wallet_hold"("walletId", "status");

-- One open hold per owner on a wallet: a second hold for the same Grant tops
-- the first one up. A closed hold is history and does not count.
CREATE UNIQUE INDEX "wallet_hold_one_open_per_owner"
    ON "billing"."wallet_hold"("walletId", "ownerRef") WHERE "status" = 'open';

ALTER TABLE "billing"."wallet_hold" ADD CONSTRAINT "wallet_hold_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "billing"."wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION billing.wallet_held_matches_holds() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target UUID;
  held NUMERIC;
  open_sum NUMERIC;
  wallet_currency TEXT;
BEGIN
  -- Separate statements: plpgsql prepares each only when it runs, and
  -- `wallet` has no "walletId" field.
  IF TG_TABLE_NAME = 'wallet' THEN
    target := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD."walletId";
  ELSE
    target := NEW."walletId";
  END IF;
  SELECT "heldAmount", "currencyCode" INTO held, wallet_currency FROM billing.wallet WHERE id = target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum(amount), 0) INTO open_sum
    FROM billing.wallet_hold WHERE "walletId" = target AND status = 'open';
  IF held <> open_sum THEN
    RAISE EXCEPTION 'wallet % holds % but its open holds sum to %', target, held, open_sum
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM billing.wallet_hold
              WHERE "walletId" = target AND status = 'open' AND "currencyCode" <> wallet_currency) THEN
    RAISE EXCEPTION 'wallet % kept in % has an open hold in another currency', target, wallet_currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER wallet_hold_matches_wallet
  AFTER INSERT OR UPDATE OR DELETE ON billing.wallet_hold
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billing.wallet_held_matches_holds();

-- Only when `heldAmount` or the currency is in the SET list: an ordinary
-- debit or credit writes neither, and pays nothing for this.
CREATE CONSTRAINT TRIGGER wallet_matches_holds
  AFTER UPDATE OF "heldAmount", "currencyCode" ON billing.wallet
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billing.wallet_held_matches_holds();
