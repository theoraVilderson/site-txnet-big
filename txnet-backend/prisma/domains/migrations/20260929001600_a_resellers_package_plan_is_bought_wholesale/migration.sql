-- F-118-p (D-58, ADR-0105 decision 0 amended 2026-09-29): a package plan a
-- reseller sells on the platform's panels is charged its bytes at the
-- package's wholesale rate on the reseller's `tenant_billing_wallet`, at the
-- sale and at every raise of its bag; the user's path is untouched.
--
-- 1. `grant_wholesale`: one row per such Grant (a plan has no `grant_meter`,
--    decision 0), written by `GrantService.issue`. The package's `vpn.traffic`
--    rate in force at the sale is copied (`rateId` is a record, not a foreign
--    key, as on `grant_meter`); `billed` is the bytes the reseller paid for,
--    `consumed` the bytes served on platform-owned panels (`metering-service`).
-- 2. The terms never change and a row is never deleted
--    (`grant_wholesale_terms_are_locked`); only the two cursors move.
-- 3. Its Grant's tenant's (`same_tenant()`), strictly tenant-scoped RLS.
--
-- No backfill: a plan sold before this has no row, so its bytes — and its
-- renewals' — stay free to the reseller, as they were.
--
-- Additive; rollback: DROP TABLE "entitlement"."grant_wholesale" and the
-- function `entitlement.grant_wholesale_terms_are_locked()`.

CREATE TABLE "entitlement"."grant_wholesale" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "payerTenantId" UUID NOT NULL,
    "rateId" UUID NOT NULL,
    "unitSize" BIGINT NOT NULL,
    "unitPrice" DECIMAL(18,8) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "billed" BIGINT NOT NULL DEFAULT 0,
    "consumed" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grant_wholesale_pkey" PRIMARY KEY ("id"),
    -- The package rate's own lines (`tenant_package_meter_rate`), held again on the copy.
    CONSTRAINT "grant_wholesale_unit_size_positive" CHECK ("unitSize" > 0),
    CONSTRAINT "grant_wholesale_unit_price_positive" CHECK ("unitPrice" > 0),
    CONSTRAINT "grant_wholesale_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$'),
    CONSTRAINT "grant_wholesale_cursors_not_negative" CHECK ("billed" >= 0 AND "consumed" >= 0)
);

CREATE UNIQUE INDEX "grant_wholesale_grantId_key" ON "entitlement"."grant_wholesale"("grantId");
CREATE INDEX "grant_wholesale_tenantId_idx" ON "entitlement"."grant_wholesale"("tenantId");

ALTER TABLE "entitlement"."grant_wholesale" ADD CONSTRAINT "grant_wholesale_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "entitlement"."grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER grant_wholesale_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "grantId" ON "entitlement"."grant_wholesale"
  FOR EACH ROW EXECUTE FUNCTION entitlement.same_tenant();

CREATE FUNCTION entitlement.grant_wholesale_terms_are_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'grant_wholesale_terms_are_locked: a Grant''s wholesale leg is never deleted'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."grantId" IS DISTINCT FROM OLD."grantId"
     OR NEW."payerTenantId" IS DISTINCT FROM OLD."payerTenantId"
     OR NEW."rateId" IS DISTINCT FROM OLD."rateId"
     OR NEW."unitSize" IS DISTINCT FROM OLD."unitSize"
     OR NEW."unitPrice" IS DISTINCT FROM OLD."unitPrice"
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'grant_wholesale_terms_are_locked: the rate a plan was sold at never changes; only its cursors move'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER grant_wholesale_terms_are_locked BEFORE UPDATE OR DELETE ON "entitlement"."grant_wholesale"
  FOR EACH ROW EXECUTE FUNCTION entitlement.grant_wholesale_terms_are_locked();

ALTER TABLE entitlement.grant_wholesale ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement.grant_wholesale FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement"."grant_wholesale" TO txnet_app, txnet_cross_tenant;

CREATE POLICY tenant_isolation ON "entitlement"."grant_wholesale"
  AS PERMISSIVE FOR ALL TO txnet_app
  USING ("tenantId" = public.current_tenant_id())
  WITH CHECK ("tenantId" = public.current_tenant_id());

CREATE POLICY cross_tenant ON "entitlement"."grant_wholesale"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);
