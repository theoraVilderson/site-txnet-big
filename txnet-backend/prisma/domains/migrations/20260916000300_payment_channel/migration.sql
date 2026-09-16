-- F-306-a: where a top-up was started. The bot reaches the deposit routes
-- through the gate like the panel, so the row is the only place that can say
-- which one it was — the payer notice tells a `bot` payer about a webhook
-- credit, where a panel payer is already looking at the success page.
--
-- Every existing row was started from the panel: nothing else called `start`.

ALTER TABLE "billing"."payment_transaction"
  ADD COLUMN "channel" "billing"."CouponChannel" NOT NULL DEFAULT 'panel';
