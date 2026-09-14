-- F-092-w — the callback address a payment provider is given, per gateway.
-- An operator whose provider terminal is registered on another domain writes it;
-- NULL keeps the tenant's own panel domain (ADR-0020), so nothing changes until set.

ALTER TABLE "billing"."payment_gateway" ADD COLUMN "callbackUrl" TEXT;
ALTER TABLE "tenant"."tenant_gateway_config" ADD COLUMN "callbackUrl" TEXT;
