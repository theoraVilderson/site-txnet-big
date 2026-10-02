-- F-038-d (ADR-0109 point 7): what predictions v1 need that F-038-c did not.
--
-- 1. `ai.prediction.currencyCode`. A wallet-need prediction's `value` is an
--    amount, and C-02 says an amount never travels without its currency; the
--    other kinds are a probability, a count of days or a ratio and carry none.
--    CHECKed both ways.
--
-- 2. The reader may SELECT `billing.deposit_setting` — the tenant's top-up
--    presets, which a wallet need is rounded up to (point 7). Same tenant
--    clause as the table's own app policy.
--
-- Additive. Rollback: DROP POLICY ai_reader ON billing.deposit_setting; REVOKE
-- SELECT ON billing.deposit_setting FROM txnet_ai_reader; ALTER TABLE
-- ai.prediction DROP COLUMN "currencyCode".

ALTER TABLE "ai"."prediction" ADD COLUMN "currencyCode" TEXT;
ALTER TABLE "ai"."prediction" ADD CONSTRAINT "prediction_amount_has_currency"
  CHECK (("kind" = 'wallet_need') = ("currencyCode" IS NOT NULL));
ALTER TABLE "ai"."prediction" ADD CONSTRAINT "prediction_currency_code_shape"
  CHECK ("currencyCode" IS NULL OR "currencyCode" ~ '^[A-Z]{3}$');

GRANT SELECT ON billing.deposit_setting TO txnet_ai_reader;
CREATE POLICY ai_reader ON billing.deposit_setting
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());
