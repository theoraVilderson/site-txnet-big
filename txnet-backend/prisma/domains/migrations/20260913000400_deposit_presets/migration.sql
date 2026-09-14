-- =============================================================================
-- F-092-v — quick amounts on the top-up page
-- =============================================================================
-- A tenant's default list (`billing.deposit_setting`) and a gateway's own
-- override (`depositPresets` on both gateway tables). Empty means "inherit" —
-- the gateway falls back to the tenant's list, and a tenant with none gets the
-- panel's automatic ladder, so nothing changes for anyone until they set one.

ALTER TABLE "billing"."payment_gateway"
  ADD COLUMN "depositPresets" DECIMAL(18,2)[] NOT NULL DEFAULT ARRAY[]::DECIMAL(18,2)[];

ALTER TABLE "tenant"."tenant_gateway_config"
  ADD COLUMN "depositPresets" DECIMAL(18,2)[] NOT NULL DEFAULT ARRAY[]::DECIMAL(18,2)[];

CREATE TABLE "billing"."deposit_setting" (
    "tenantId" UUID NOT NULL,
    "presets" DECIMAL(18,2)[] NOT NULL DEFAULT ARRAY[]::DECIMAL(18,2)[],
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposit_setting_pkey" PRIMARY KEY ("tenantId")
);

-- Strict shape (`20260909001500_row_level_security_all_tables`, shape A): every
-- row is exactly one tenant's, read and write. The same loop as that migration,
-- so `rls-coverage.spec.ts` reads the table name the way it reads every other.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing.deposit_setting'
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

    -- Spelled for the reason `20260912000200_gateway_grant_and_settlement` gives:
    -- a table nobody may SELECT from fails as "no rows", which reads like a policy working.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);
  END LOOP;
END
$$;
