-- =============================================================================
-- Section 99 — Row-Level Security, the rest of the schema (F-1202, F-066-m-b)
-- =============================================================================
-- `20260909000500_row_level_security` built the machinery — `current_tenant_id()`,
-- the `txnet_app` / `txnet_cross_tenant` group roles, the grants — and policied
-- the two tables the application already scoped. This migration finishes the
-- job: **every remaining table with a `tenantId` column**, 23 of them.
--
-- Nothing here is new machinery. It is the same function, the same two roles
-- and the same two policy names, applied to the rest of the schema. What is new
-- is that three policy *shapes* are needed, because `tenantId` does not mean the
-- same thing on every table:
--
--   A. strict          — every row belongs to exactly one tenant, read and
--                        write. This is the default: the 14 tables whose
--                        `tenantId` is NOT NULL, plus any nullable one whose
--                        NULL the schema does not document as a share. 15
--                        tables.
--   B. shared-read     — `tenantId` is nullable and the schema documents NULL as
--                        "platform-wide" (`tenantId=null یعنی … مشترک پلتفرم`).
--                        A tenant may *see* the platform's row and may not
--                        *write* one. 5 tables.
--   C. attributed-late — `tenantId` is nullable and NULL is not a share: it is a
--                        row not attributed to a tenant. Readable only by the
--                        cross-tenant pool, writable by the app pool, which is
--                        exactly right for an append-only log. 3 tables.
--
-- The shape per table is chosen from what the schema comment says, never from
-- what would be convenient — see the three lists below, each with its reason.
--
-- WHY THIS COULD NOT SHIP WITH F-066-m-a
--
-- Five of these tables are read *before* a tenant is resolved: `tenant_domain`
-- (which host belongs to whom), the three vault tables (`tenant_dek`,
-- `tenant_credential`, `tenant_credential_access`) and `bot_integration` (which
-- bot a webhook path belongs to). Policying them while the application still
-- read them on the app pool would take domain resolution and the vault offline —
-- silently, as zero rows. They are readable again in the same change, from the
-- other side: `CrossTenantPrismaService` (`prisma/cross-tenant-prisma.service.ts`)
-- connects as `txnet_cross_tenant_user`, whose policy below is `USING (true)`.
--
-- That is a policy and not a bypass, and the distinction is the whole of
-- F-1202's "bypassing RLS on the normal pool is not possible": neither role
-- carries `BYPASSRLS`, so there is no connection string in this system that
-- turns the rules off. The cross-tenant role sees everything because a row in
-- `pg_policy` says so, which is auditable, revocable, and per-table.
--
-- WHO IS EXEMPT, AND WHY THAT IS NOT A HOLE
--
-- `FORCE ROW LEVEL SECURITY` subjects a table's owner to its own policies. It
-- does not, and cannot, subject a superuser — Postgres exempts those
-- unconditionally. `MAIN_DB_USERNAME` is the superuser the image creates, and it
-- is what `prisma migrate` and `prisma db seed` connect as, which is why seeding
-- still works after this migration. No service connects that way
-- (`env.validation.ts` requires `DATABASE_APP_URL` and offers no fallback), and
-- a deployment that gives the migration role something less than superuser must
-- also grant it membership of `txnet_cross_tenant` or the seed will insert
-- nothing.
--
-- NOT IN THIS MIGRATION, ON PURPOSE
--
--   * `tenant.tenant` itself. It has no `tenantId` column — it *is* the tenant —
--     so a policy on it would read `id = current_tenant_id()`, a different rule
--     with a different set of readers (the resolver reaches it before any scope
--     exists). It is a row of its own, not a line in this one.
--   * the catalog's `resellerPath` half of `(tenantId, resellerPath)`. No table
--     in this schema has such a column, because sub-reseller hierarchy is not
--     built (F-311/F-312). There is nothing to write a policy against yet.
--
-- Rollback: `DROP POLICY tenant_isolation, cross_tenant` and `ALTER TABLE …
-- DISABLE ROW LEVEL SECURITY` on the tables listed below.
--
-- Coverage is asserted, not trusted: `tenant-context/rls-coverage.spec.ts`
-- reads `prisma/domains/*.prisma` and this history and fails on a `tenantId`
-- table no policy names. A model that gains the column next month fails that
-- spec on the day it is added rather than the day it leaks.
-- =============================================================================

-- A. --------------------------------------------------------------- strict
--
-- On fourteen of these `tenantId` is NOT NULL, so there is no third case to
-- write a rule for: a row is one tenant's, in both directions. This is the same
-- policy body F-066-m-a used, and it is the default — a table reaches list B or
-- C only by having a documented reason to, read off the schema rather than
-- inferred from the column's shape.
--
-- `engagement.spin_wheel_config` is the fifteenth, and it is here *because* its
-- nullable `tenantId` carries no comment. Its neighbours in list B each say, in
-- the schema, that NULL means the platform's shared row; this one says nothing,
-- so it gets the default and a NULL row is invisible to the app pool. That is
-- the safe direction to be wrong in, and `engagement` has no service to be
-- wrong for yet — the session that builds one decides, with the domain in front
-- of it, whether a platform-wide wheel is a thing. Moving a table from A to B
-- later is one line; discovering that B was wrong is a leak.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant.tenant_branding',
    'tenant.tenant_domain',
    'tenant.tenant_feature_entitlement',
    'tenant.tenant_staff_member',
    'tenant.tenant_billing_wallet',
    'tenant.tenant_usage_meter',
    'tenant.tenant_gateway_config',
    'tenant.tenant_sms_config',
    'tenant.tenant_restriction',
    'tenant.tenant_dek',
    'tenant.tenant_credential',
    'tenant.tenant_credential_access',
    'automation.bot_integration',
    'network.config',
    'engagement.spin_wheel_config'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);

    EXECUTE format('DROP POLICY IF EXISTS cross_tenant ON %s', t);
    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END
$$;

-- B. ---------------------------------------------------------- shared-read
--
-- On these five the schema says, in as many words, that NULL means the platform's
-- own row and that every tenant is meant to see it: a shared product category
-- (4.1), a shared service plan (4.2), a node in the shared pool (5.1), a
-- platform-wide campaign, a platform-wide coupon. Reading is therefore
-- `NULL OR mine`.
--
-- Writing is not. `WITH CHECK` stays strict, so a tenant-scoped connection can
-- create its own row and can never create — or update a row into — the
-- platform-wide set. That asymmetry is the point: the read side is a feature and
-- the write side would be a privilege escalation, and one policy can say both.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'catalog.product_category',
    'catalog.service_plan',
    'network.panel',
    'notification.notification_campaign',
    'billing.coupon'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);

    EXECUTE format('DROP POLICY IF EXISTS cross_tenant ON %s', t);
    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END
$$;

-- C. ------------------------------------------------------- attributed-late
--
-- Three append-only records whose `tenantId` is denormalized for reporting, not
-- a statement of ownership. NULL here means "no tenant attributed", never
-- "everyone's" — an admin action taken above any tenant, a ledger row written
-- before attribution. Reading is strict, so the app pool never sees an
-- unattributed row and a tenant can never read the platform's audit trail.
--
-- `WITH CHECK` is the mirror of list B, and for a concrete reason:
-- `ImpersonationService` writes `admin_audit_log` rows with no `tenantId`
-- today, inside an interactive transaction that `withTenant` cannot bind
-- (`tenant-context/contract.md` rule 5). A strict `WITH CHECK` would refuse
-- that insert, and refusing to write an audit row is a worse failure than
-- writing an unattributed one: the operation would fail *because* it was being
-- recorded. Attributing those rows is F-066-o's, once the admin surface carries
-- a tenant of its own.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'audit.admin_audit_log',
    'billing.wallet_transaction',
    'billing.payment_transaction'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
    $p$, t);

    EXECUTE format('DROP POLICY IF EXISTS cross_tenant ON %s', t);
    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END
$$;
