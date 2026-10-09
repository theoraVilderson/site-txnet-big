-- GR-1-d (ADR-0139 (3), (5)): a membership's end is set when a member is
-- added, and moved or cleared later in place. Moving it is its own audited act.
--
-- Rollback: none needed — an unused enum value is harmless.

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'user_group_member_end_set';
