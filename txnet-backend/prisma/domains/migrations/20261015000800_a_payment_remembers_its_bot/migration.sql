-- F-093-u: the bot a top-up was started in, as the link the bot sent with
-- `start` (https, at most 200 characters, kept only beside the service token).
-- The callback signs it into the result token, and the panel's result page
-- offers "back to the bot". NULL: started in the panel, or before this column.

ALTER TABLE "billing"."payment_transaction" ADD COLUMN "returnBotLink" TEXT;
