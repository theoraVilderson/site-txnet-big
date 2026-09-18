-- F-104-ab: an in-chat payment's messenger events are matched to the payment,
-- not to the chat's session.
--
-- `payerChatPlatform` + `payerChatId`: the messenger and the id `start` read
-- from the gate's chat scope (`X-Chat-Platform` / `X-Chat-User-Id`). billing
-- admits a relayed `pre_checkout_query` / `successful_payment` only from this
-- sender. NULL on every other payment, and on an in-chat one started before
-- this migration — which the relay then refuses; it expires within its TTL,
-- so there is no backfill.
--
-- Rollback: drop the constraint and both columns.

ALTER TABLE "billing"."payment_transaction"
  ADD COLUMN "payerChatPlatform" TEXT,
  ADD COLUMN "payerChatId" TEXT;

-- A payer is whole or absent: an id means nothing without its messenger.
ALTER TABLE "billing"."payment_transaction"
  ADD CONSTRAINT "payment_transaction_in_chat_payer_whole"
    CHECK (("payerChatPlatform" IS NULL) = ("payerChatId" IS NULL));
