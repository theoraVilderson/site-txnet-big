-- A reseller's staff seats (F-018-j, catalog F-1201, D-42 (2)).
--
-- `tenant_staff_member` was written at init with an RBAC of its own:
-- `roleWithinTenant` over the `TenantStaffRole` enum (owner/admin/support/
-- finance_viewer). D-42 (2) chose **one** RBAC instead, and F-018-n built it —
-- `identity.role` now carries a `tenantId`, so a reseller composes its own
-- roles out of the platform's global permission keys. A second, fixed ladder
-- beside it would be a role a token cannot carry: `forward-auth` reads
-- `user.roleId` and nothing else, so `roleWithinTenant` could never have
-- decided a request. It is dropped rather than kept as documentation of an
-- intent that was overtaken.
--
-- What the table holds now is membership alone: invited, accepted, until when,
-- and removed. A member's permissions are their `identity.user.roleId`, a role
-- of this tenant.
--
-- `isActive` goes with it. It was a boolean for three different facts — not yet
-- accepted, access expired, removed — each of which now has the column that
-- says which one it is, and a boolean cannot say *when*. `revokedAt` keeps the
-- trail a delete would lose: who was on this reseller's team last month is a
-- question an audit asks.
--
-- `(tenantId, userId)` becomes unique: one membership per person per reseller.
-- Re-inviting someone who was removed reuses their row (revokedAt back to
-- NULL), so the history does not fork into two rows for one person.
--
-- No FK on `userId` or `invitedByUserId` into `identity.user`. Same reasoning as
-- `role.tenantId` (20260919000200) and `linked_bot_account.tenantId`: the
-- cross-schema structural SQL is collected in F-041 / F-066-m, and both columns
-- are written in one place (`TenantStaffService`) from a user row it has just
-- read in this tenant.
--
-- The table is already policied (20260909001500, shape A strict), and nothing
-- here changes its `tenantId`, so RLS is untouched.
--
-- Data: the table is empty on every environment — no service has ever written
-- it (F-018-j is its first writer), so the drop needs no backfill. If a row did
-- exist, `roleWithinTenant` would be the only value lost, and the member's real
-- role is their user's.
--
-- Rollback: drop the four columns and the unique index, re-create the enum, and
-- add `roleWithinTenant` / `isActive` back — `roleWithinTenant` NOT NULL only
-- while the table is empty, which is the state this migration finds it in.

-- AlterTable
ALTER TABLE "tenant"."tenant_staff_member"
  DROP COLUMN "roleWithinTenant",
  DROP COLUMN "isActive",
  ADD COLUMN "invitedByUserId" UUID,
  ADD COLUMN "accessExpiresAt" TIMESTAMP(3),
  ADD COLUMN "revokedAt" TIMESTAMP(3);

-- DropEnum
DROP TYPE "tenant"."TenantStaffRole";

-- CreateIndex
CREATE UNIQUE INDEX "tenant_staff_member_tenantId_userId_key" ON "tenant"."tenant_staff_member"("tenantId", "userId");
