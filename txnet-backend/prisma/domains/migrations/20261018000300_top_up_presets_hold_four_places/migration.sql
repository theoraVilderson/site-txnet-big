-- F-116-q, the rest of 20261018000200: a gateway's and a tenant's top-up presets
-- are amounts too, in arrays the column scan did not see.
ALTER TABLE "billing"."payment_gateway"
  ALTER COLUMN "depositPresets" TYPE DECIMAL(20,4)[]; -- contract: F-116-q
ALTER TABLE "billing"."deposit_setting"
  ALTER COLUMN "presets" TYPE DECIMAL(20,4)[]; -- contract: F-116-q
ALTER TABLE "tenant"."tenant_gateway_config"
  ALTER COLUMN "depositPresets" TYPE DECIMAL(20,4)[]; -- contract: F-116-q

-- The rebuilt AI reader views took the `ai` schema's default privileges, which
-- give the app roles write; before, only the AI reader read them.
REVOKE ALL ON ai.reader_billing_event, ai.reader_reseller, ai.reader_wallet, ai.reader_wholesale_spend
  FROM txnet_app, txnet_cross_tenant;
