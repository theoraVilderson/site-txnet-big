-- =============================================================================
-- A granted gateway, and what it collects (ADR-0041, D-27, F-096-a)
-- =============================================================================
-- ADR-0006 said each tenant must connect its own gateway, so end-user money
-- never reached the platform. ADR-0041 keeps that as the default and opens one
-- exception: the platform owner may **grant** a gateway to a tenant that does
-- not own it. The cash then lands in the gateway owner's merchant account while
-- the paying user's wallet is credited inside the borrowing tenant — so the
-- platform owes that tenant, and this migration is where that debt lives.
--
-- Schema and constraints only. No service reads any of it yet: the list and the
-- quote learn about grants in F-096-b, the credential crossing is F-096-c, the
-- accrual F-096-d and the operator surface F-096-e.
--
-- THREE TABLES, AND WHY THEY ARE THREE
--
--   payment_gateway_grant      who may use whose gateway. A record, not a
--                              setting: it is withdrawn, never deleted, because
--                              a payment taken under it keeps pointing at it.
--   gateway_settlement_entry   what a granted gateway collected, one row per
--                              payment, append-only. The debt.
--   gateway_settlement_payout  what was actually transferred, recorded by a
--                              person with their proof. The repayment.
--
-- What is still owed is the first minus the second. It is deliberately not a
-- running balance column: ADR-0041 §5 says the ledger, and not an operator's
-- memory, says what is outstanding — and a cached total is a second memory.

-- -----------------------------------------------------------------------------
-- The grant
-- -----------------------------------------------------------------------------
-- `tenantId` is the **borrowing** tenant, the one the grant is *to*. It carries
-- that name rather than `granteeTenantId` because it is the column RLS and the
-- `withTenant` extension key on, and a grant is exactly the borrower's to see.
-- Which tenant owns the gateway is the gateway row's business.
CREATE TABLE "billing"."payment_gateway_grant" (
  "id"                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"              UUID         NOT NULL,
  "gatewayId"             UUID,
  "tenantGatewayConfigId" UUID,
  "grantedByAdminId"      UUID         NOT NULL,
  "isActive"              BOOLEAN      NOT NULL DEFAULT true,
  "grantedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "withdrawnAt"           TIMESTAMP(3),
  "withdrawnByAdminId"    UUID,
  "note"                  TEXT,

  CONSTRAINT "payment_gateway_grant_pkey" PRIMARY KEY ("id")
);

-- Exactly one gateway column, the same rule and the same reason as
-- `payment_transaction`'s (ADR-0006, ADR-0028): a grant names the platform's
-- own gateway or one reseller's, and neither "both" nor "neither" is a state
-- any reader could act on. Prisma cannot express it.
ALTER TABLE "billing"."payment_gateway_grant"
  ADD CONSTRAINT "payment_gateway_grant_one_gateway"
  CHECK (num_nonnulls("gatewayId", "tenantGatewayConfigId") = 1);

-- A withdrawal is a state, so it must be a consistent one: withdrawn rows carry
-- when and by whom, live rows carry neither.
ALTER TABLE "billing"."payment_gateway_grant"
  ADD CONSTRAINT "payment_gateway_grant_withdrawal_is_complete"
  CHECK (
    ("isActive" AND "withdrawnAt" IS NULL AND "withdrawnByAdminId" IS NULL)
    OR (NOT "isActive" AND "withdrawnAt" IS NOT NULL AND "withdrawnByAdminId" IS NOT NULL)
  );

ALTER TABLE "billing"."payment_gateway_grant"
  ADD CONSTRAINT "payment_gateway_grant_gatewayId_fkey"
  FOREIGN KEY ("gatewayId") REFERENCES "billing"."payment_gateway"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing"."payment_gateway_grant"
  ADD CONSTRAINT "payment_gateway_grant_tenantGatewayConfigId_fkey"
  FOREIGN KEY ("tenantGatewayConfigId") REFERENCES "tenant"."tenant_gateway_config"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- **One live grant per (tenant, gateway), and any number of dead ones.** A
-- partial unique index and not a plain one: granting, withdrawing and granting
-- again is an ordinary sequence, and a plain key would make the second grant
-- impossible while a plain absence of a key would let two live rows disagree
-- about whether a tenant may use a gateway.
CREATE UNIQUE INDEX "payment_gateway_grant_live_platform_gateway"
  ON "billing"."payment_gateway_grant" ("tenantId", "gatewayId")
  WHERE "isActive" AND "gatewayId" IS NOT NULL;

CREATE UNIQUE INDEX "payment_gateway_grant_live_tenant_gateway"
  ON "billing"."payment_gateway_grant" ("tenantId", "tenantGatewayConfigId")
  WHERE "isActive" AND "tenantGatewayConfigId" IS NOT NULL;

CREATE INDEX "payment_gateway_grant_tenantId_isActive_idx"
  ON "billing"."payment_gateway_grant" ("tenantId", "isActive");

-- -----------------------------------------------------------------------------
-- What a payment was taken under
-- -----------------------------------------------------------------------------
-- NULL is the ordinary case — the tenant used a gateway it owns. Non-null means
-- the money landed in somebody else's merchant account.
ALTER TABLE "billing"."payment_transaction" ADD COLUMN "grantId" UUID;

ALTER TABLE "billing"."payment_transaction"
  ADD CONSTRAINT "payment_transaction_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "billing"."payment_gateway_grant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "payment_transaction_grantId_idx"
  ON "billing"."payment_transaction" ("grantId");

-- -----------------------------------------------------------------------------
-- The debt
-- -----------------------------------------------------------------------------
-- One row per payment, enforced by a unique key rather than by the code that
-- writes it: F-096-d writes this inside the crediting transaction, and that
-- transaction is reached by a callback a bank retries and by a reconciliation
-- sweep (ADR-0028, invariant 7). A second accrual for one payment would be the
-- platform owing the same money twice.
CREATE TABLE "billing"."gateway_settlement_entry" (
  "id"                   UUID           NOT NULL DEFAULT gen_random_uuid(),
  "grantId"              UUID           NOT NULL,
  "tenantId"             UUID           NOT NULL,
  "paymentTransactionId" UUID           NOT NULL,
  -- Base currency, like every money column here (ADR-0019, C-02).
  "amount"               DECIMAL(18,2)  NOT NULL,
  "accruedAt"            TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gateway_settlement_entry_pkey" PRIMARY KEY ("id")
);

-- An accrual is money owed and never negative; zero is possible (a fee that ate
-- the whole payment) and is not an error.
ALTER TABLE "billing"."gateway_settlement_entry"
  ADD CONSTRAINT "gateway_settlement_entry_amount_non_negative"
  CHECK ("amount" >= 0);

ALTER TABLE "billing"."gateway_settlement_entry"
  ADD CONSTRAINT "gateway_settlement_entry_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "billing"."payment_gateway_grant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing"."gateway_settlement_entry"
  ADD CONSTRAINT "gateway_settlement_entry_paymentTransactionId_fkey"
  FOREIGN KEY ("paymentTransactionId") REFERENCES "billing"."payment_transaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "gateway_settlement_entry_paymentTransactionId_key"
  ON "billing"."gateway_settlement_entry" ("paymentTransactionId");

CREATE INDEX "gateway_settlement_entry_tenantId_accruedAt_idx"
  ON "billing"."gateway_settlement_entry" ("tenantId", "accruedAt" DESC);

-- -----------------------------------------------------------------------------
-- The repayment
-- -----------------------------------------------------------------------------
-- A payout is never automatic (ADR-0041 §5): an operator moves the money
-- outside this system and records it here, with their own identity and the
-- transfer's proof. `proofAttachmentKey` is a key in an object store that does
-- not exist yet — D-8's port, landing with F-033 — so nothing resolves it and
-- F-096-e is where an operator puts one there.
CREATE TABLE "billing"."gateway_settlement_payout" (
  "id"                 UUID           NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"           UUID           NOT NULL,
  "amount"             DECIMAL(18,2)  NOT NULL,
  "paidAt"             TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedByAdminId"  UUID           NOT NULL,
  "method"             TEXT,
  "reference"          TEXT,
  "proofAttachmentKey" TEXT,
  "notes"              TEXT,

  CONSTRAINT "gateway_settlement_payout_pkey" PRIMARY KEY ("id")
);

-- A payout of nothing is a record of nothing, and a negative one is a
-- withdrawal dressed as a settlement.
ALTER TABLE "billing"."gateway_settlement_payout"
  ADD CONSTRAINT "gateway_settlement_payout_amount_positive"
  CHECK ("amount" > 0);

CREATE INDEX "gateway_settlement_payout_tenantId_paidAt_idx"
  ON "billing"."gateway_settlement_payout" ("tenantId", "paidAt" DESC);

-- -----------------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------------
-- Shape A (strict) from `20260909001500_row_level_security_all_tables`: every
-- row belongs to exactly one tenant, and `tenantId` is NOT NULL on all three.
-- The borrowing tenant may read its own grants, its own accruals and its own
-- payouts; nobody else's are visible on the application pool, and the
-- cross-tenant role sees all of them by a policy that says so.
--
-- Writing is the platform owner's, and that is **not** enforced here: the admin
-- surface is F-096-e's and has no tenant of its own yet (the same gap
-- `admin_audit_log` has). What this migration guarantees is isolation of
-- reading, which is what a reseller could otherwise exploit.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'billing.payment_gateway_grant',
    'billing.gateway_settlement_entry',
    'billing.gateway_settlement_payout'
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

    -- Redundant with the ALTER DEFAULT PRIVILEGES in
    -- `20260909000500_row_level_security`, and spelled anyway: a default
    -- privilege applies only to tables created by the role that set it, and a
    -- table nobody may SELECT from fails as "no rows", which reads exactly like
    -- a policy working.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);
  END LOOP;
END
$$;
