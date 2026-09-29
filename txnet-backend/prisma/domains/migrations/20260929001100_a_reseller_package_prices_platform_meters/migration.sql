-- F-118-n1 (D-58, ADR-0105 decision 10): the wholesale price list.
--
-- A reseller's user consuming a platform meter on the platform's panels is
-- charged twice: the reseller's own rate card bills the user, and the platform
-- bills the reseller. The second price lives on the reseller's package (user,
-- 2026-09-29), so a tier — or a negotiated deal, sold as a package of its
-- own — prices every reseller on it without a row per reseller.
--
-- 1. History, like `rate_card`: a new price is a new row and only `isActive`
--    changes, so a Grant that locked a price (F-118-n2) can always be traced
--    to the row it came from. No DELETE for the app roles at all: a package is
--    never deleted either (RESTRICT).
-- 2. In the package's currency — the platform's (ADR-0098 part 4). A platform
--    currency change writes new rows (`currency-change.ts`), as it does for
--    rate cards; the old rows stay in the old money, read by nothing.
-- 3. `Decimal(18, 8)` and a positive price: a metered unit costs something
--    (`rate_card_metered_price_positive`). No price is "switched off".
-- 4. The meter by key, RESTRICT both ways, as `rate_card`.
-- 5. No `tenantId`, no RLS: `tenant_feature_package` is platform data the app
--    pool serves, and only the platform owner's service writes it.
--
-- Rollback: DROP TABLE tenant.tenant_package_meter_rate; DROP FUNCTION
-- tenant.package_meter_rate_is_history().

CREATE TABLE "tenant"."tenant_package_meter_rate" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "meterKey" TEXT NOT NULL,
    "unitSize" BIGINT NOT NULL,
    "unitPrice" DECIMAL(18,8) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_package_meter_rate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_package_meter_rate_unit_size_positive" CHECK ("unitSize" > 0),
    CONSTRAINT "tenant_package_meter_rate_price_positive" CHECK ("unitPrice" > 0),
    CONSTRAINT "tenant_package_meter_rate_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$')
);

-- In force: the newest active row per (package, meter) at or before the instant.
CREATE INDEX "tenant_package_meter_rate_packageId_meterKey_effectiveFrom_idx"
  ON "tenant"."tenant_package_meter_rate"("packageId", "meterKey", "effectiveFrom" DESC);

ALTER TABLE "tenant"."tenant_package_meter_rate" ADD CONSTRAINT "tenant_package_meter_rate_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "tenant"."tenant_feature_package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant"."tenant_package_meter_rate" ADD CONSTRAINT "tenant_package_meter_rate_meterKey_fkey"
  FOREIGN KEY ("meterKey") REFERENCES "catalog"."meter"("key") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION tenant.package_meter_rate_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."packageId", NEW."meterKey", NEW."unitSize", NEW."unitPrice", NEW."currencyCode",
      NEW."effectiveFrom", NEW."createdByAdminId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."packageId", OLD."meterKey", OLD."unitSize", OLD."unitPrice", OLD."currencyCode",
      OLD."effectiveFrom", OLD."createdByAdminId", OLD."createdAt") THEN
    RAISE EXCEPTION 'package_meter_rate_is_history: only isActive changes on a wholesale rate; write a new one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER package_meter_rate_is_history BEFORE UPDATE ON "tenant"."tenant_package_meter_rate"
  FOR EACH ROW EXECUTE FUNCTION tenant.package_meter_rate_is_history();

GRANT SELECT, INSERT, UPDATE ON "tenant"."tenant_package_meter_rate" TO txnet_app, txnet_cross_tenant;
REVOKE DELETE, TRUNCATE ON "tenant"."tenant_package_meter_rate" FROM txnet_app, txnet_cross_tenant;
