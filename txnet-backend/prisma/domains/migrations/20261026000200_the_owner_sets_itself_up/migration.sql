-- F-0102-a: the seeded platform owner sets its own username, password and phone
-- on its first sign-in. Additive: every existing account defaults to false.
ALTER TABLE "identity"."user" ADD COLUMN "setupRequired" BOOLEAN NOT NULL DEFAULT false;

-- An install seeded before this column: its owner is still the seed's account
-- while it keeps the seed's username, so it is asked to set itself up too.
UPDATE "identity"."user" AS u
SET "setupRequired" = true
FROM "tenant"."tenant" AS t
WHERE t."ownerUserId" = u.id
  AND t."tenantType" = 'platform_owner'
  AND u.username = 'platform_owner'
  AND u."deletedAt" IS NULL;
