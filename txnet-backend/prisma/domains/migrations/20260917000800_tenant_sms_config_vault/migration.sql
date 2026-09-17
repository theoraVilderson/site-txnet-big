-- F-018-a: a tenant's SMS key lives in the vault (`sms_api_key`), so the
-- column ADR-0026 deprecated goes. It was never written by any code. One SMS
-- configuration per tenant.
ALTER TABLE "tenant"."tenant_sms_config" DROP COLUMN "ownApiKeyEncrypted";

CREATE UNIQUE INDEX "tenant_sms_config_tenantId_key" ON "tenant"."tenant_sms_config"("tenantId");
