-- F-210 (ADR-0157): an import's commit links a source client's Telegram
-- account to its person as a claim, never a proof — `claimedAt` marks it, and
-- it carries nothing until the chat's own contact card sets
-- `contactVerifiedAt`. The item keeps what became of it for the report.
-- Additive: two nullable columns; every existing row stays null.

ALTER TABLE "identity"."linked_bot_account" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "entitlement"."migration_item" ADD COLUMN "telegramLink" TEXT;
