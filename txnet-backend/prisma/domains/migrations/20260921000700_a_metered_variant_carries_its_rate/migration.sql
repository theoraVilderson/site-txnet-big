-- F-027-g — a metered variant carries its own rate history (ADR-0073).
--
-- Nothing in the catalog can express a per-byte price today. `catalog.price` is
-- per **variant**, `DECIMAL(18, 2)`, effective from a date, and has no per-unit
-- dimension at all — there is no way to say "$0.40 per GiB".
--
-- 1. A new table rather than a unit column on `price`. `price` is read by
--    invoicing and reseller revenue; adding a dimension to it changes the
--    meaning of every row already written, for one new consumer (ADR-0073,
--    alternatives).
-- 2. `DECIMAL(18, 8)`, the precision `tenant.tenant_usage_meter.unitPrice` and
--    `billing.currency_exchange_rate.rate` already use. At two places the only
--    expressible rates are 1c steps per GiB. `C-02` governs *amounts*: every
--    amount derived from this rate is rounded to whole cents before the ledger
--    sees it (ADR-0072), so nothing finer than two places is written as money.
-- 3. Shaped exactly like `price`, down to both of its triggers. A rate row that
--    could be edited in place would reprice traffic already sold — and under
--    ADR-0072, blocks already **bought**, so the ledger and the byte cursor
--    would disagree about what a byte cost with nothing to reconcile them
--    from. `metered_rate_is_history` is what makes the lock on
--    `Grant.meteredRate` (F-027-p) mean something.
-- 4. The rate is per 2^30 bytes. The constant is `METERED_RATE_UNIT_BYTES` in
--    shared-core and is spelled nowhere else; bytes are the only stored unit.
--
-- Additive: one new table, no column on an existing one, and nothing reads it
-- until F-027-p. Rollback: drop the table, its trigger and its function.

CREATE TABLE "catalog"."metered_rate" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "variantId" UUID NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByAdminId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metered_rate_pkey" PRIMARY KEY ("id"),
    -- Zero is a variant metered but not charged for (a trial, an internal
    -- account); below zero would pay the user to move bytes.
    CONSTRAINT "metered_rate_not_negative" CHECK ("rate" >= 0)
);

-- Resolution at sale (F-027-p) asks `price`'s question of this table: the
-- newest active row at or before the instant.
CREATE INDEX "metered_rate_variantId_effectiveFrom_idx" ON "catalog"."metered_rate"("variantId", "effectiveFrom" DESC);
CREATE INDEX "metered_rate_tenantId_idx" ON "catalog"."metered_rate"("tenantId");

ALTER TABLE "catalog"."metered_rate" ADD CONSTRAINT "metered_rate_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "catalog"."product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- A child carries its parent's tenant (invariant 3)
-- `same_tenant_as_parent` (20260914001500) reads `NEW."variantId"` in its ELSE
-- branch, which is this table as much as it is `price`.
-- -----------------------------------------------------------------------------
CREATE TRIGGER metered_rate_same_tenant BEFORE INSERT OR UPDATE OF "tenantId", "variantId" ON "catalog"."metered_rate"
  FOR EACH ROW EXECUTE FUNCTION catalog.same_tenant_as_parent();

-- -----------------------------------------------------------------------------
-- A rate row is history, as a price row is (invariant 2, ADR-0073)
-- -----------------------------------------------------------------------------
CREATE FUNCTION catalog.metered_rate_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'metered_rate_is_history: a rate row is never deleted; switch it off or write a new one'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW."variantId", NEW."tenantId", NEW."rate", NEW."effectiveFrom", NEW."createdByAdminId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."variantId", OLD."tenantId", OLD."rate", OLD."effectiveFrom", OLD."createdByAdminId", OLD."createdAt") THEN
    RAISE EXCEPTION 'metered_rate_is_history: only isActive changes on a rate row; write a new one'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER metered_rate_is_history BEFORE UPDATE OR DELETE ON "catalog"."metered_rate"
  FOR EACH ROW EXECUTE FUNCTION catalog.metered_rate_is_history();

-- -----------------------------------------------------------------------------
-- Row-Level Security: shared-read, as `price`
-- (20260909001500_row_level_security_all_tables, list B)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'catalog.metered_rate'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO txnet_app, txnet_cross_tenant', t);

    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %s
        AS PERMISSIVE FOR ALL TO txnet_app
        USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id())
        WITH CHECK ("tenantId" = public.current_tenant_id())
    $p$, t);

    EXECUTE format($p$
      CREATE POLICY cross_tenant ON %s
        AS PERMISSIVE FOR ALL TO txnet_cross_tenant
        USING (true) WITH CHECK (true)
    $p$, t);
  END LOOP;
END
$$;
