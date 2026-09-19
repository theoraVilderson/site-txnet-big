-- Tenant-scoped roles (F-018-n, ADR-0062, D-42 (2)). `identity.role` gains a
-- nullable `tenantId`: non-null means the role belongs to that tenant and only
-- that tenant may edit it; null means a **system template**, readable by every
-- tenant and writable by none.
--
-- Why nullable rather than a second table. One RBAC, not two (D-42 (2)): a
-- token carries one `roleId`, `forward-auth` compares one fingerprint, and
-- `role_permission` stays the single relation `permissionFingerprint` runs
-- over (identity/invariants.md #14). A `tenant_role` table beside `role` would
-- fork all three. The permission **keys** stay global — a key names a capability
-- of the platform, so a reseller composes keys, it does not invent them.
--
-- Why the existing rows become templates. Every role today (`user`, `Admin`,
-- `SuperAdmin`, ...) is held by users across every tenant, and null is exactly
-- what those rows mean: a shared definition with no owner. So the column is
-- added nullable and never backfilled, and nothing that reads a role by id
-- changes behaviour — which is what keeps the fingerprint + Redis path
-- (F-101-a/b) working untouched: it keys a role by `id`, never by name.
--
-- The uniqueness. `name` was globally `@unique`; two resellers must be able to
-- call a role `Support`. `(tenantId, name)` says that, but NULLs are distinct
-- in Postgres, so it would let two templates share a name — hence the second,
-- partial index over `name WHERE "tenantId" IS NULL`. Together they are exactly
-- the old constraint for templates plus one namespace per tenant.
--
-- No FK to `tenant.tenant`. Same reasoning as `linked_bot_account.tenantId`
-- (20260909000400): the structural SQL is collected in F-041 / F-066-m, and
-- this column is written in one place (`RolesService`, from the caller's own
-- claims) rather than by any path that could invent a tenant id.
--
-- Rollback: drop the two indexes and the column, re-create
-- `role_name_key ON identity.role(name)`. That re-creation succeeds only while
-- no two tenants hold the same role name — the state this migration exists to
-- allow — so the window closes with the first duplicate name.

-- AlterTable
ALTER TABLE "identity"."role" ADD COLUMN "tenantId" UUID;

-- DropIndex
DROP INDEX "identity"."role_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "role_tenantId_name_key" ON "identity"."role"("tenantId", "name");

-- One template per name: `(tenantId, name)` cannot say this, because two NULL
-- tenants never collide.
CREATE UNIQUE INDEX "role_system_name_key" ON "identity"."role"("name") WHERE "tenantId" IS NULL;

-- CreateIndex
CREATE INDEX "role_tenantId_idx" ON "identity"."role"("tenantId");

-- ---------------------------------------------------------------------------
-- Row-Level Security: shape B, shared-read (20260909001500 section 99).
-- ---------------------------------------------------------------------------
-- `role` now carries a `tenantId`, so it must be policied — that rule is the
-- whole of `rls-coverage.spec.ts`, and it is the failure that is otherwise
-- silent. Shape B is the one the column already means: NULL is the platform's
-- shared row and every tenant is meant to see it.
--
-- Reading is `NULL OR mine`, so a tenant sees its own roles and the templates.
-- Writing stays strict: `WITH CHECK ("tenantId" = current_tenant_id())` means
-- a tenant-scoped connection can never create a template, nor update one of
-- its own roles into the shared set. That asymmetry is exactly ADR-0062 (1),
-- now stated in the database rather than only in `RolesService`.
--
-- What this does NOT say: `DELETE` has no `WITH CHECK`, so the `USING` clause
-- alone admits a template row to a delete. `RolesService.ownRole` is what
-- refuses it (invariant #9) — do not read this policy as covering that.
--
-- One consequence, handled in the same change:
-- `PermissionNotificationsListener` recomputes roles across every tenant from
-- a LISTEN callback, which has no ambient tenant. On the app pool that read
-- now returns templates only, so the listener moves to
-- `CrossTenantPrismaService`, whose `cross_tenant` policy below is
-- `USING (true)`. That is a policy, never a bypass.
DO $$
BEGIN
  ALTER TABLE identity.role ENABLE ROW LEVEL SECURITY;
  ALTER TABLE identity.role FORCE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS tenant_isolation ON identity.role;
  CREATE POLICY tenant_isolation ON identity.role
    AS PERMISSIVE FOR ALL TO txnet_app
    USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
    WITH CHECK ("tenantId" = public.current_tenant_id());

  DROP POLICY IF EXISTS cross_tenant ON identity.role;
  CREATE POLICY cross_tenant ON identity.role
    AS PERMISSIVE FOR ALL TO txnet_cross_tenant
    USING (true) WITH CHECK (true);
END
$$;
