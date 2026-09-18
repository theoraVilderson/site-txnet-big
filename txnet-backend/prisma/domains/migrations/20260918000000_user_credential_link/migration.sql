-- F-061-c — a reseller's owner is a linked account in the reseller's tenant (ADR-0059).
--
-- `credentialUserId` names the account whose password and 2FA a linked account
-- signs in with; such an account stores no password, so `passwordHash` loses
-- NOT NULL. One linked account per (tenant, linked account): the unique index
-- is what makes the internal create idempotent under a race. NULLs are
-- distinct, so every unlinked account passes it.
--
-- Rollback: DROP the index, the FK and the column; SET NOT NULL on
-- `passwordHash` only after deleting the linked accounts.

ALTER TABLE "identity"."user" ALTER COLUMN "passwordHash" DROP NOT NULL;

ALTER TABLE "identity"."user" ADD COLUMN "credentialUserId" UUID;

ALTER TABLE "identity"."user" ADD CONSTRAINT "user_credentialUserId_fkey"
  FOREIGN KEY ("credentialUserId") REFERENCES "identity"."user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "user_tenantId_credentialUserId_key"
  ON "identity"."user"("tenantId", "credentialUserId");
