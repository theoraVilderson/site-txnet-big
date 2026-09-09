-- A domain says what it is for (F-066-q, catalog 20.3 / F-1212, C-16).
--
-- `tenant_domain` gains `purpose`. Every purpose resolves to the same tenant —
-- that is the half of F-1212 that already worked — but only a `panel` domain
-- serves a panel route, and the allowlist that enforces it needs the column to
-- read (`auth-service/src/app/tenant/tenant.ts`, `surfaceServesPath`).
--
-- Why `panel` is the default and the column is NOT NULL from the first
-- statement: every row that exists is a panel domain, in the literal sense that
-- serving the panel is the only thing this platform does on a host today. A
-- nullable column would have made "unset" a fourth state the resolver has to
-- decide about, and the safe reading of unset (serve nothing) would have taken
-- every existing deployment down on deploy. So the default is the permissive
-- value and the restriction is opt-in per row, which is the only ordering in
-- which this migration and the code that reads it can ship in either order.
--
-- Scope: catalog 13.1 also gives `TenantDomain` a `state`, a `tlsStatus` and
-- health columns. Those are F-102 / F-113 / F-115 and are deliberately absent —
-- this migration adds the one column F-1212 names, so the rest arrives with the
-- rows that give it meaning rather than as unread columns.
--
-- RLS: `tenant.tenant_domain` already carries its `tenant_isolation` and
-- `cross_tenant` policies from `20260909001500_row_level_security_all_tables`.
-- A new column inherits them; nothing here re-states a policy.
--
-- Rollback: `ALTER TABLE ... DROP COLUMN "purpose"` then `DROP TYPE`. It is
-- lossless only while no row has been set to a non-`panel` purpose; after that,
-- which host serves what is data, not schema.

-- CreateEnum
CREATE TYPE "tenant"."TenantDomainPurpose" AS ENUM ('panel', 'subscription', 'assets');

-- AlterTable
ALTER TABLE "tenant"."tenant_domain"
  ADD COLUMN "purpose" "tenant"."TenantDomainPurpose" NOT NULL DEFAULT 'panel';
