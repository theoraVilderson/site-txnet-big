-- ADR-0034 — a switch moves the place, not one session.
--
-- Additive and nullable: every existing group reads `NULL`, which means "this
-- place has never switched" and preserves ADR-0014's behaviour exactly. There
-- is nothing to backfill, and the rollback is the DROP COLUMN below.
--
-- No FK to identity."user" on purpose. The column is a *pointer into the
-- group*, and the group's own membership rows are what guarantee the account
-- is real and still a member; a stale pointer is read through
-- `linked_account_member`, so a deleted user resolves to no member and the
-- sign-in falls back to the link rather than failing. A cross-schema RESTRICT
-- would instead block deleting a user who once switched.
ALTER TABLE "audit"."linked_account_group"
  ADD COLUMN "actingAsUserId" UUID;

-- Rollback:
--   ALTER TABLE "audit"."linked_account_group" DROP COLUMN "actingAsUserId";
