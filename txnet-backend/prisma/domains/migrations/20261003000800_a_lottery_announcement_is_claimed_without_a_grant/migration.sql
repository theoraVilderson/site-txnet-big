-- F-707-q: a new lottery's announcement to its group's members is claimed on
-- the notice ledger per lottery and member, about no service — like an AI
-- suggestion about none (F-038-g5). The CHECK widens to that one notice; no
-- row changes. Once per (notice, period) is the existing partial unique index
-- `retention_notice_grantless_key`; the period names lottery and member.

ALTER TABLE "notification"."retention_notice" DROP CONSTRAINT "retention_notice_grant_unless_suggestion";

ALTER TABLE "notification"."retention_notice"
  ADD CONSTRAINT "retention_notice_grant_unless_suggestion" CHECK ("grantId" IS NOT NULL OR "notice" IN ('ai.suggestion', 'engagement.lottery.published'));
