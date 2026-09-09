-- A bot link is unique within a tenant, not across the platform (F-066-l,
-- catalog 10.5). `identity.linked_bot_account` gains `tenantId` and its
-- platform-wide `(platform, platformUserId)` unique index becomes
-- `(tenantId, platform, platformUserId)`.
--
-- Why the column is denormalized rather than reached through `user`: a unique
-- index cannot span a join. The value is exactly `user.tenantId` for the row's
-- own user, and both write paths go through the ambient tenant scope
-- (`withTenant`, ADR-0024) after finding that user in the same scope, so the
-- two cannot diverge without the scope itself being wrong. A composite FK to
-- `user(tenantId, id)` would enforce it in the database; that needs a unique
-- index on `user(tenantId, id)` and belongs with the rest of the structural
-- SQL (F-041 / F-066-m), not here.
--
-- Backfill, then NOT NULL: every existing row has a user, and that user has a
-- non-null `tenantId` (identity/invariants.md #5), so no row can fail to
-- migrate and the column is never nullable in a state anything runs against.
--
-- The new constraint is strictly weaker than the one it replaces, so the
-- expand step is safe in either order. Rollback plan: drop the composite
-- index, re-create `linked_bot_account_platform_platformUserId_key`, drop the
-- column. That re-creation succeeds only while no two tenants have linked the
-- same chat id — which is the state this migration exists to allow — so the
-- rollback window closes with the first cross-tenant link. After that, which
-- reseller keeps the chat is a data decision, not a migration.

-- AlterTable
ALTER TABLE "identity"."linked_bot_account" ADD COLUMN "tenantId" UUID;

-- Backfill from the owning user.
UPDATE "identity"."linked_bot_account" AS l
SET "tenantId" = u."tenantId"
FROM "identity"."user" AS u
WHERE u."id" = l."userId";

ALTER TABLE "identity"."linked_bot_account" ALTER COLUMN "tenantId" SET NOT NULL;

-- DropIndex
DROP INDEX "identity"."linked_bot_account_platform_platformUserId_key";

-- CreateIndex
CREATE UNIQUE INDEX "linked_bot_account_tenantId_platform_platformUserId_key" ON "identity"."linked_bot_account"("tenantId", "platform", "platformUserId");
