-- F-503-a: creating and cancelling a price campaign are audited, as a price is.
-- Additive (enum values cannot be removed; unused ones are harmless).

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_campaign_create';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_campaign_cancel';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'price_campaign';
