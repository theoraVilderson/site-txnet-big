-- F-311-h: an admin freezes a Grant — `suspended` with
-- `statusReason = 'admin_frozen'`, its clock stopped. `frozenUntil` is when a
-- timed freeze ends by itself (null = until the admin unfreezes it), set only
-- on a frozen Grant and after the instant it froze (`suspendedAt`).
--
-- Additive; rollback: drop the index, the CHECK and the column.

ALTER TABLE "entitlement"."grant"
  ADD COLUMN "frozenUntil" TIMESTAMP(3),
  ADD CONSTRAINT "grant_frozen_until_is_frozen" CHECK (
      "frozenUntil" IS NULL
      OR ("status" = 'suspended' AND "statusReason" = 'admin_frozen' AND "frozenUntil" > "suspendedAt"));

CREATE INDEX "grant_status_frozenUntil_idx" ON "entitlement"."grant"("status", "frozenUntil");
