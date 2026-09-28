-- F-116-j (ADR-0098 part 9): a tenant's pin is its own. `currency_exchange_rate`
-- gained `tenantId` in the previous migration, so it is policied like every
-- tenant-scoped table (`rls-coverage.spec.ts`), in the nullable shape
-- `admin_audit_log` uses: a row with no tenant — every discovered rate and the
-- platform's pins — is everyone's; a tenant's pin is visible and writable only
-- inside that tenant. Unbound (the FX worker), `current_tenant_id()` is NULL
-- and only the no-tenant rows are seen, which is all the worker reads or writes.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'currency.currency_exchange_rate'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
    $p$, t);

    EXECUTE format('DROP POLICY IF EXISTS cross_tenant ON %s', t);
    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END $$;
