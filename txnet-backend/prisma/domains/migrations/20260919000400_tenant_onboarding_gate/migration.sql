-- F-018-l (catalog F-213) — the onboarding gate.
--
-- A reseller with no `verified` custom domain reaches only the configuration
-- console: the `onboarding` column of `TenantStatusPolicy` closes `register`,
-- `sell`, `endUserDeposit` and `subscriptionLink` on top of its status.
--
-- The column is computed, never stored: `TenantStatusListener` reads the
-- tenant's domains when it writes `tenant:status:<id>`. What this migration
-- adds is the second reason to wake that listener — until now only
-- `tenant.status` / `graceEndsAt` notified, so a domain reaching `verified`
-- (the sweep, `tenant_domain_verification`) left a stale gate in Redis until
-- the next connect. The notification carries the tenant id only, exactly as
-- `20260917001500_tenant_status` does; the listener recomputes the rest.
--
-- No column, table or enum value is added. Rollback: drop the trigger and the
-- function.

CREATE OR REPLACE FUNCTION tenant.notify_tenant_domain_status_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'tenant_status_changed',
    json_build_object('tenantId', CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END)::text
  );
  RETURN NULL;
END
$$;

-- `purpose` and `domainType` are in the list because the gate counts a
-- `panel` `custom_domain`: a domain that keeps its status and changes either
-- of them changes the answer too.
CREATE TRIGGER tenant_domain_status_changed
  AFTER INSERT OR DELETE OR UPDATE OF "verificationStatus", "purpose", "domainType" ON tenant.tenant_domain
  FOR EACH ROW EXECUTE FUNCTION tenant.notify_tenant_domain_status_changed();
