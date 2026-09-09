-- =============================================================================
-- Section 99 — Row-Level Security (catalog 20.2 layer 1 / F-1202, F-066-m-a)
-- =============================================================================
-- Hand-written, not generated: Prisma cannot express RLS. It lives in this same
-- history, and is applied before the first production data, per
-- `docs/operations/migrations.md`.
--
-- What this migration establishes:
--
--   1. `public.current_tenant_id()` — the tenant the current transaction acts
--      for, read from the `app.tenant_id` setting the application binds beside
--      every scoped query (`tenant-context/with-tenant.ts`).
--   2. Two group roles. `txnet_app` is what the service connects as; its policy
--      shows it one tenant's rows. `txnet_cross_tenant` is the audited escape;
--      its policy shows it every row. **Neither carries BYPASSRLS** — the
--      escape is a policy, not a bypass, which is what makes "bypassing RLS on
--      the normal pool is not possible" true of both pools rather than of one.
--   3. RLS, ENABLEd and FORCEd, on the tables the application scopes today.
--
-- FORCE is not decoration. Without it a table's owner is exempt from its own
-- policies, and the owner here is the role `prisma migrate` runs as.
--
-- Rollback: `DROP POLICY tenant_isolation, cross_tenant` and
-- `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` on the two tables below. The
-- roles and the function are additive and can be left in place.
--
-- NOT in this migration, on purpose (F-066-m-b):
--   * the remaining ~20 `tenantId` tables. Every one of them belongs to a
--     domain with no service behind it, or is read *before* a tenant is
--     resolved (`tenant_domain`, the vault, `bot_integration`) and therefore
--     needs the cross-tenant pool to exist in application code first. Enabling
--     RLS on those here would take the vault and the resolver offline.
--   * the catalog's `resellerPath` half of `(tenantId, resellerPath)`. No table
--     in this schema has such a column, because sub-reseller hierarchy is not
--     built (F-311/F-312) — there is nothing to write a policy against yet.
--     Carried by the F-066-m-b backlog row.
-- =============================================================================

-- 1. ---------------------------------------------------------------- the setting
--
-- `current_setting(..., true)` is the missing-is-NULL form: a connection that
-- bound nothing gets NULL rather than an error, and `"tenantId" = NULL` is
-- never true. Unscoped therefore means *no rows*, never *all rows*, which is
-- the direction this whole layer has to fail in.
CREATE OR REPLACE FUNCTION public.current_tenant_id() RETURNS uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- 2. ------------------------------------------------------------------ the roles
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'txnet_app') THEN
    CREATE ROLE txnet_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'txnet_cross_tenant') THEN
    CREATE ROLE txnet_cross_tenant NOLOGIN;
  END IF;
END
$$;

-- Asserted rather than assumed: a role that already existed with BYPASSRLS
-- would make every policy below decorative, and nothing would report it.
ALTER ROLE txnet_app NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE txnet_cross_tenant NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- 3. ----------------------------------------------------------------- the grants
-- Both roles may read and write every domain schema. What separates them is
-- the policy, not the grant: a GRANT decides which *tables* a role may touch,
-- and RLS decides which *rows*. Splitting the two is what lets the cross-tenant
-- role exist without a second copy of every privilege.
GRANT USAGE ON SCHEMA public TO txnet_app, txnet_cross_tenant;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO txnet_app, txnet_cross_tenant;

GRANT USAGE ON SCHEMA
  identity, tenant, fraud, currency, catalog, network, billing,
  governance, automation, engagement, support, notification, audit, ai
  TO txnet_app, txnet_cross_tenant;

DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'identity','tenant','fraud','currency','catalog','network','billing',
    'governance','automation','engagement','support','notification','audit','ai'
  ]
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO txnet_app, txnet_cross_tenant', s);
    EXECUTE format(
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO txnet_app, txnet_cross_tenant', s);
    -- Every table a *later* migration creates is covered without that migration
    -- having to remember. A table the app cannot see is a 42501 at runtime, and
    -- "the developer who never read this document" is exactly who would hit it.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO txnet_app, txnet_cross_tenant', s);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO txnet_app, txnet_cross_tenant', s);
  END LOOP;
END
$$;

-- 4. --------------------------------------------------- the policies, per table
--
-- `identity.user` and `identity.linked_bot_account` are `TENANT_SCOPED_MODELS`
-- (F-066-b, F-066-l): every query on them already carries a `tenantId`, so RLS
-- here is the backstop under an application rule that is already true, not a
-- new constraint on working code. That is what makes them the two to do first.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['identity."user"', 'identity.linked_bot_account']
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

    -- The escape, as a policy. `USING (true)` is broad on purpose and narrow in
    -- reach: it is only ever evaluated for a connection made with the
    -- cross-tenant credentials, and nothing but the audited escape holds those.
    EXECUTE format('DROP POLICY IF EXISTS cross_tenant ON %s', t);
    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END
$$;
