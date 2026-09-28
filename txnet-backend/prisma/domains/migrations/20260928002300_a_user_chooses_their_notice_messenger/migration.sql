-- F-601-u (ADR-0097 part 2): a user chooses which messenger their notices
-- take — Telegram, Bale or both. Null is "not chosen" and reads as both, so
-- no backfill: every existing user keeps the default.
--
-- Additive; rollback: drop the column and the type, nothing else reads them.

CREATE TYPE "identity"."NoticeMessenger" AS ENUM ('telegram', 'bale', 'both');

ALTER TABLE "identity"."user" ADD COLUMN "noticeMessenger" "identity"."NoticeMessenger";
