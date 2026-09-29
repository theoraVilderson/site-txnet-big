-- F-118-m (D-58, ADR-0105 decision 10): a seller writes its own rate cards
-- through the catalog routes. A card is history, as a price is: a write is a
-- new row (`catalog_rate_card_set`), a switch-off only flips `isActive`
-- (`catalog_rate_card_deactivate`), and each is audited against the card.
--
-- Enum values only; nothing is rewritten. Rollback: none needed — an unused
-- enum value is inert (Postgres cannot drop one without recreating the type).

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_rate_card_set';
ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'catalog_rate_card_deactivate';
ALTER TYPE "audit"."AuditTargetType" ADD VALUE IF NOT EXISTS 'rate_card';
