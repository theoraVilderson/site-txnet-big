-- F-116-n (user, 2026-09-28): a manual rate may have no end — it is live until
-- a person ends it (`currency_rate_pin_end`). The pin shape keeps its reason
-- and its admin; an expiry, when there is one, is still after the start. Only
-- loosened: every row the old check admitted, this one admits.
ALTER TABLE "currency"."currency_exchange_rate"
    DROP CONSTRAINT "currency_exchange_rate_pin_shape";

ALTER TABLE "currency"."currency_exchange_rate"
    ADD CONSTRAINT "currency_exchange_rate_pin_shape" CHECK (
        ("source" = 'manual_admin'
            AND "reason" IS NOT NULL AND btrim("reason") <> ''
            AND ("expiresAt" IS NULL OR "expiresAt" > "effectiveAt")
            AND "setByAdminId" IS NOT NULL)
        OR ("source" <> 'manual_admin' AND "reason" IS NULL AND "expiresAt" IS NULL)
    );
