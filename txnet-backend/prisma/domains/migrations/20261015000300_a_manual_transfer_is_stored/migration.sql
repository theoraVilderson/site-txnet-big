-- F-803-a, D-60: the storage of a manual transfer — a gateway's manual
-- setting, the cards and wallets it shows, what one payment showed and the
-- proof it got, and the external references already credited
-- (billing/contract.manual-transfer.md "Storage"). Additive, apart from the
-- one index below that is replaced by a narrower one.

-- A reseller runs one gateway per provider (D-20) — except `manual_transfer`,
-- of which it may run several: a card and two wallets are three gateways, each
-- with its own limits, fee and proof (user, 2026-10-15). The full index is
-- replaced by the same index without the manual rows; no existing row can
-- break the narrower one.
DROP INDEX "tenant"."tenant_gateway_config_tenantId_providerName_key";
CREATE UNIQUE INDEX "tenant_gateway_config_tenantId_providerName_key" ON "tenant"."tenant_gateway_config"("tenantId", "providerName")
  WHERE "providerName" <> 'manual_transfer';

-- CreateEnum
CREATE TYPE "billing"."TransferReviewReason" AS ENUM ('underpaid', 'overpaid', 'late', 'wrong_destination', 'duplicate_ref', 'amount_collision', 'no_match', 'proof_only');

-- CreateTable
CREATE TABLE "billing"."manual_gateway_setting" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "gatewayId" UUID,
    "tenantGatewayConfigId" UUID,
    "kind" TEXT NOT NULL,
    "confirmationMode" "billing"."ConfirmationMode" NOT NULL DEFAULT 'manual_admin_required',
    "requiredProof" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "windowMinutes" INTEGER NOT NULL DEFAULT 30,
    "instructions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manual_gateway_setting_pkey" PRIMARY KEY ("id"),
    -- Exactly one gateway, like `gateway_audience`.
    CONSTRAINT "manual_gateway_setting_one_gateway" CHECK (("gatewayId" IS NULL) <> ("tenantGatewayConfigId" IS NULL)),
    -- The kind is a registry id in code, so a new kind needs no migration (principle 2).
    CONSTRAINT "manual_gateway_setting_kind" CHECK ("kind" ~ '^[a-z][a-z0-9_]{1,39}$'),
    CONSTRAINT "manual_gateway_setting_window" CHECK ("windowMinutes" BETWEEN 10 AND 1440),
    CONSTRAINT "manual_gateway_setting_instructions" CHECK ("instructions" IS NULL OR jsonb_typeof("instructions") = 'object')
);

-- CreateTable
CREATE TABLE "billing"."manual_destination" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "settingId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "dailyCapMinor" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manual_destination_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "manual_destination_label" CHECK (length("label") BETWEEN 1 AND 100),
    CONSTRAINT "manual_destination_fields" CHECK (jsonb_typeof("fields") = 'object'),
    CONSTRAINT "manual_destination_weight" CHECK ("weight" BETWEEN 1 AND 100),
    CONSTRAINT "manual_destination_daily_cap" CHECK ("dailyCapMinor" IS NULL OR "dailyCapMinor" > 0)
);

-- CreateTable
CREATE TABLE "billing"."payment_transfer_detail" (
    "paymentId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "destinationId" UUID NOT NULL,
    "destinationSnapshot" JSONB NOT NULL,
    "expectedAmountMinor" BIGINT NOT NULL,
    "chargeCurrency" TEXT NOT NULL,
    "chargeDecimals" INTEGER NOT NULL,
    "network" TEXT,
    "windowEndsAt" TIMESTAMP(3) NOT NULL,
    "proof" JSONB,
    "proofSubmittedAt" TIMESTAMP(3),
    "reviewReason" "billing"."TransferReviewReason",
    "seenTxRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_transfer_detail_pkey" PRIMARY KEY ("paymentId"),
    CONSTRAINT "payment_transfer_detail_expected" CHECK ("expectedAmountMinor" > 0),
    -- The same shape as `payment_transaction.receivedCurrency` (F-104-a).
    CONSTRAINT "payment_transfer_detail_currency" CHECK ("chargeCurrency" ~ '^[A-Z0-9]{2,20}$'),
    CONSTRAINT "payment_transfer_detail_decimals" CHECK ("chargeDecimals" BETWEEN 0 AND 18),
    -- A proof and the moment it arrived are written together (F-805-a).
    CONSTRAINT "payment_transfer_detail_proof" CHECK (("proof" IS NULL) = ("proofSubmittedAt" IS NULL))
);

-- CreateTable
CREATE TABLE "billing"."transfer_tx_ref" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "network" TEXT NOT NULL,
    "txRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_tx_ref_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transfer_tx_ref_network" CHECK (length("network") BETWEEN 1 AND 64),
    CONSTRAINT "transfer_tx_ref_ref" CHECK (length("txRef") BETWEEN 1 AND 200)
);

-- CreateIndex
CREATE UNIQUE INDEX "manual_gateway_setting_gatewayId_key" ON "billing"."manual_gateway_setting"("gatewayId");
CREATE UNIQUE INDEX "manual_gateway_setting_tenantGatewayConfigId_tenantId_key" ON "billing"."manual_gateway_setting"("tenantGatewayConfigId", "tenantId");
CREATE UNIQUE INDEX "manual_gateway_setting_id_tenantId_key" ON "billing"."manual_gateway_setting"("id", "tenantId");
CREATE INDEX "manual_gateway_setting_tenantId_idx" ON "billing"."manual_gateway_setting"("tenantId");
CREATE UNIQUE INDEX "manual_destination_id_tenantId_key" ON "billing"."manual_destination"("id", "tenantId");
CREATE INDEX "manual_destination_settingId_isActive_sortOrder_idx" ON "billing"."manual_destination"("settingId", "isActive", "sortOrder");
CREATE INDEX "manual_destination_tenantId_idx" ON "billing"."manual_destination"("tenantId");
CREATE INDEX "payment_transfer_detail_tenantId_idx" ON "billing"."payment_transfer_detail"("tenantId");
CREATE INDEX "payment_transfer_detail_destinationId_idx" ON "billing"."payment_transfer_detail"("destinationId");
CREATE UNIQUE INDEX "transfer_tx_ref_tenantId_network_txRef_key" ON "billing"."transfer_tx_ref"("tenantId", "network", "txRef");
CREATE INDEX "transfer_tx_ref_paymentId_idx" ON "billing"."transfer_tx_ref"("paymentId");

-- AddForeignKey
ALTER TABLE "billing"."manual_gateway_setting" ADD CONSTRAINT "manual_gateway_setting_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "billing"."payment_gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Composite, as `gateway_audience`'s: a reseller's setting is on its own gateway.
ALTER TABLE "billing"."manual_gateway_setting" ADD CONSTRAINT "manual_gateway_setting_tenantGatewayConfigId_tenantId_fkey" FOREIGN KEY ("tenantGatewayConfigId", "tenantId") REFERENCES "tenant"."tenant_gateway_config"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "billing"."manual_destination" ADD CONSTRAINT "manual_destination_settingId_tenantId_fkey" FOREIGN KEY ("settingId", "tenantId") REFERENCES "billing"."manual_gateway_setting"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict: the destination a payment showed is evidence; it is deactivated, never deleted.
ALTER TABLE "billing"."payment_transfer_detail" ADD CONSTRAINT "payment_transfer_detail_destinationId_tenantId_fkey" FOREIGN KEY ("destinationId", "tenantId") REFERENCES "billing"."manual_destination"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing"."payment_transfer_detail" ADD CONSTRAINT "payment_transfer_detail_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "billing"."payment_transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing"."transfer_tx_ref" ADD CONSTRAINT "transfer_tx_ref_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "billing"."payment_transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only a `manual_transfer` gateway has a manual setting, and a platform
-- gateway's (no tenant column of its own) is the platform owner's — the
-- `gateway_audience_owner_ok` rule.
CREATE OR REPLACE FUNCTION billing.manual_gateway_setting_owner_ok() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  provider text;
BEGIN
  -- Neither gateway: the `one_gateway` CHECK refuses it by name.
  IF NEW."gatewayId" IS NULL AND NEW."tenantGatewayConfigId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."gatewayId" IS NOT NULL THEN
    SELECT g."providerName"::text INTO provider FROM billing.payment_gateway g WHERE g.id = NEW."gatewayId";
    IF NOT EXISTS (SELECT 1 FROM tenant.tenant t WHERE t.id = NEW."tenantId" AND t."tenantType" = 'platform_owner') THEN
      RAISE EXCEPTION 'manual_gateway_setting: a platform gateway''s setting is the platform owner''s'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT c."providerName"::text INTO provider FROM tenant.tenant_gateway_config c WHERE c.id = NEW."tenantGatewayConfigId";
  END IF;
  IF provider IS DISTINCT FROM 'manual_transfer' THEN
    RAISE EXCEPTION 'manual_gateway_setting: only a manual_transfer gateway has one'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER manual_gateway_setting_owner_ok BEFORE INSERT OR UPDATE ON "billing"."manual_gateway_setting"
  FOR EACH ROW EXECUTE FUNCTION billing.manual_gateway_setting_owner_ok();

-- A detail and a reference carry their payment's tenant, for RLS. A trigger,
-- not a composite key: `payment_transaction` holds production rows, and the
-- `(id, tenantId)` index a composite key needs would lock it while it builds.
CREATE OR REPLACE FUNCTION billing.transfer_row_tenant_ok() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM billing.payment_transaction p WHERE p.id = NEW."paymentId" AND p."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION '%: the row''s tenant is not its payment''s tenant', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER payment_transfer_detail_tenant_ok BEFORE INSERT OR UPDATE ON "billing"."payment_transfer_detail"
  FOR EACH ROW EXECUTE FUNCTION billing.transfer_row_tenant_ok();
CREATE TRIGGER transfer_tx_ref_tenant_ok BEFORE INSERT OR UPDATE ON "billing"."transfer_tx_ref"
  FOR EACH ROW EXECUTE FUNCTION billing.transfer_row_tenant_ok();

-- Strict shape (`20260909001500_row_level_security_all_tables`, shape A), on all four.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing.manual_gateway_setting',
    'billing.manual_destination',
    'billing.payment_transfer_detail',
    'billing.transfer_tx_ref'
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);
  END LOOP;
END
$$;
