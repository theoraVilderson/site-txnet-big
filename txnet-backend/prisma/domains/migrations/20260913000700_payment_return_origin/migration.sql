-- The panel origin a deposit was started from (the browser's Origin, checked
-- against CORS and the tenant's panel domains). The gateway callback can arrive
-- on a relay or the API host, so the result page is sent back here. NULL keeps
-- the relative redirect.

ALTER TABLE "billing"."payment_transaction" ADD COLUMN "returnOrigin" TEXT;
