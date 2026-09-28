-- F-116-f (ADR-0098 part 5): changing a tenant's operating currency converts
-- what is live and leaves history alone.
--
-- 1. `billing.currency_change` — one row per change: the pair, the rate it
--    crossed at (18 places, as a payment's, F-116-e) and the two readings
--    behind it. It is the evidence, and what a ledger reads to credit money
--    that was priced before the change and arrives after it (an in-flight
--    payment, a refund of an older invoice) at the change's rate.
--    Written only on the cross-tenant pool; read by the owning tenant, and the
--    platform's rows by every tenant, because a reseller's billing top-up is
--    credited in the platform's currency.
-- 2. `wallet_transaction.sourceAmount` / `sourceCurrencyCode` — what such a
--    converted credit was before the conversion. Both or neither.
-- 3. The tenant <-> platform tables record their currency (ADR-0098 parts 3-4;
--    the columns F-116-g builds on): `tenant_billing_wallet`,
--    `tenant_billing_transaction` (+ the source pair), `tenant_feature_package`,
--    `tenant_usage_meter`. Backfilled with the platform's currency today;
--    then NOT NULL, no default. A billing ledger row in another currency than
--    its wallet's is refused by a trigger, as a user's is (F-116-b).
-- 4. A currency change's closing and opening rows on the billing ledger all
--    name the change, so the one-entry-per-(reason, reference) index excludes
--    that reason.
--
-- Rollback: DROP TABLE "billing"."currency_change"; drop the trigger and its
-- function; drop the added columns; recreate the index without the reason
-- clause (valid again once no two currency_change rows share a reference).

-- 1 ---------------------------------------------------------------------------
CREATE TABLE "billing"."currency_change" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "fromCode" TEXT NOT NULL,
    "toCode" TEXT NOT NULL,
    "rate" DECIMAL(30,18) NOT NULL,
    "fromSnapshotId" UUID,
    "toSnapshotId" UUID,
    "changedByUserId" UUID NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "currency_change_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "currency_change_codes_shape" CHECK ("fromCode" ~ '^[A-Z]{3}$' AND "toCode" ~ '^[A-Z]{3}$'),
    CONSTRAINT "currency_change_is_a_change" CHECK ("fromCode" <> "toCode"),
    CONSTRAINT "currency_change_rate_positive" CHECK ("rate" > 0),
    CONSTRAINT "currency_change_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"."tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "currency_change_fromSnapshotId_fkey" FOREIGN KEY ("fromSnapshotId") REFERENCES "currency"."currency_exchange_rate"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "currency_change_toSnapshotId_fkey" FOREIGN KEY ("toSnapshotId") REFERENCES "currency"."currency_exchange_rate"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- A ledger walks a tenant's changes newest first.
CREATE INDEX "currency_change_tenantId_createdAt_idx" ON "billing"."currency_change"("tenantId", "createdAt" DESC);

ALTER TABLE billing.currency_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.currency_change FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "billing"."currency_change" TO txnet_app, txnet_cross_tenant;

-- Read-only for the app pool: its own tenant's changes and the platform's.
CREATE POLICY tenant_isolation ON "billing"."currency_change"
  AS PERMISSIVE FOR SELECT TO txnet_app
  USING (
    "tenantId" = public.current_tenant_id()
    OR EXISTS (SELECT 1 FROM tenant.tenant t WHERE t.id = "tenantId" AND t."tenantType" = 'platform_owner')
  );

CREATE POLICY cross_tenant ON "billing"."currency_change"
  AS PERMISSIVE FOR ALL TO txnet_cross_tenant
  USING (true) WITH CHECK (true);

-- 2 ---------------------------------------------------------------------------
ALTER TABLE "billing"."wallet_transaction"
    ADD COLUMN "sourceAmount" DECIMAL(18,2),
    ADD COLUMN "sourceCurrencyCode" TEXT,
    ADD CONSTRAINT "wallet_transaction_source_both_or_neither" CHECK (("sourceAmount" IS NULL) = ("sourceCurrencyCode" IS NULL)),
    ADD CONSTRAINT "wallet_transaction_source_shape" CHECK (
      "sourceCurrencyCode" IS NULL OR ("sourceCurrencyCode" ~ '^[A-Z]{3}$' AND "sourceAmount" > 0 AND "sourceCurrencyCode" <> "currencyCode")
    );

-- 3 ---------------------------------------------------------------------------
ALTER TABLE "tenant"."tenant_billing_wallet" ADD COLUMN "currencyCode" TEXT;
ALTER TABLE "tenant"."tenant_billing_transaction"
    ADD COLUMN "currencyCode" TEXT,
    ADD COLUMN "sourceAmount" DECIMAL(18,2),
    ADD COLUMN "sourceCurrencyCode" TEXT;
ALTER TABLE "tenant"."tenant_feature_package" ADD COLUMN "currencyCode" TEXT;
ALTER TABLE "tenant"."tenant_usage_meter" ADD COLUMN "currencyCode" TEXT;

UPDATE "tenant"."tenant_billing_wallet" SET "currencyCode" = coalesce(
  (SELECT "operatingCurrencyCode" FROM tenant.tenant WHERE "tenantType" = 'platform_owner' LIMIT 1), 'USD');
UPDATE "tenant"."tenant_billing_transaction" SET "currencyCode" = coalesce(
  (SELECT "operatingCurrencyCode" FROM tenant.tenant WHERE "tenantType" = 'platform_owner' LIMIT 1), 'USD');
UPDATE "tenant"."tenant_feature_package" SET "currencyCode" = coalesce(
  (SELECT "operatingCurrencyCode" FROM tenant.tenant WHERE "tenantType" = 'platform_owner' LIMIT 1), 'USD');
UPDATE "tenant"."tenant_usage_meter" SET "currencyCode" = coalesce(
  (SELECT "operatingCurrencyCode" FROM tenant.tenant WHERE "tenantType" = 'platform_owner' LIMIT 1), 'USD');

ALTER TABLE "tenant"."tenant_billing_wallet"
    ALTER COLUMN "currencyCode" SET NOT NULL,
    ADD CONSTRAINT "tenant_billing_wallet_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "tenant"."tenant_billing_transaction"
    ALTER COLUMN "currencyCode" SET NOT NULL,
    ADD CONSTRAINT "tenant_billing_transaction_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "tenant_billing_transaction_source_both_or_neither" CHECK (("sourceAmount" IS NULL) = ("sourceCurrencyCode" IS NULL)),
    ADD CONSTRAINT "tenant_billing_transaction_source_shape" CHECK (
      "sourceCurrencyCode" IS NULL OR ("sourceCurrencyCode" ~ '^[A-Z]{3}$' AND "sourceAmount" > 0 AND "sourceCurrencyCode" <> "currencyCode")
    );
ALTER TABLE "tenant"."tenant_feature_package"
    ALTER COLUMN "currencyCode" SET NOT NULL,
    ADD CONSTRAINT "tenant_feature_package_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');
ALTER TABLE "tenant"."tenant_usage_meter"
    ALTER COLUMN "currencyCode" SET NOT NULL,
    ADD CONSTRAINT "tenant_usage_meter_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');

CREATE FUNCTION tenant.tenant_billing_transaction_in_wallet_currency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  wallet_currency TEXT;
BEGIN
  SELECT "currencyCode" INTO wallet_currency FROM tenant.tenant_billing_wallet WHERE id = NEW."walletId";
  IF wallet_currency IS DISTINCT FROM NEW."currencyCode" THEN
    RAISE EXCEPTION 'tenant_billing_transaction in % for wallet % kept in %', NEW."currencyCode", NEW."walletId", wallet_currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_billing_transaction_in_wallet_currency
  BEFORE INSERT ON tenant.tenant_billing_transaction
  FOR EACH ROW EXECUTE FUNCTION tenant.tenant_billing_transaction_in_wallet_currency();

-- 4 ---------------------------------------------------------------------------
DROP INDEX "tenant"."tenant_billing_transaction_reason_reference_key";
CREATE UNIQUE INDEX "tenant_billing_transaction_reason_reference_key"
  ON "tenant"."tenant_billing_transaction" ("reasonType", "referenceId")
  WHERE "referenceId" IS NOT NULL AND "reasonType" <> 'currency_change';
