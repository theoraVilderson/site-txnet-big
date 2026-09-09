-- A person is identified within a tenant, not across the platform (ADR-0023,
-- F-065-b). `identity.user.username` and `identity.user.phoneNumber` lose
-- their platform-wide unique indexes and gain one composite index each, on
-- `(tenantId, <column>)`.
--
-- Not destructive in the sense the policy guards against: the new constraint
-- is strictly weaker than the one it replaces, so every row that satisfied
-- the old indexes satisfies the new ones and nothing can fail to migrate.
-- No backfill, no expand/contract pair.
--
-- Rollback plan: drop the two composite indexes and re-create
-- `user_username_key` / `user_phoneNumber_key` as they stood in
-- `20260908000000_init`. That succeeds only while no two tenants have taken
-- the same username or phone number — which is exactly the state this
-- migration exists to allow — so the rollback window closes with the first
-- cross-tenant duplicate. After that, the reverse is a data decision (whose
-- account keeps the number), not a migration.
--
-- NULLs are unaffected: Postgres treats them as distinct in a unique index,
-- so several users per tenant may still have no username, as before.

-- DropIndex
DROP INDEX "identity"."user_username_key";

-- DropIndex
DROP INDEX "identity"."user_phoneNumber_key";

-- CreateIndex
CREATE UNIQUE INDEX "user_tenantId_username_key" ON "identity"."user"("tenantId", "username");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenantId_phoneNumber_key" ON "identity"."user"("tenantId", "phoneNumber");
