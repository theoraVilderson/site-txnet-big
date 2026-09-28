-- F-116-h6 (ADR-0098 part 3) — a coupon applies only in its own currency.
--
-- A coupon's money (a fixed value, a percentage's cap, the purchase bounds)
-- is in `coupon.currencyCode`. A platform USD coupon on a reseller's IRR order
-- was held as if 2 dollars were 2 rials. Validation now converts that money at
-- the live rate, USD pivot (`coupon-validation.ts`, the user's call
-- 2026-09-28), and the redemption records what it crossed at:
--   "fxFromCode"        the coupon's currency when converted, else NULL;
--   "fxRate"            one unit of it in the order's "currencyCode";
--   "fxSnapshotId"      the order currency's leg (NULL when it is USD);
--   "fxFromSnapshotId"  the coupon currency's leg (NULL when it is USD).
-- As `payment_transaction`'s two legs (20260928002700), both reference
-- `currency.currency_exchange_rate` ON DELETE RESTRICT. No backfill: every row
-- before this was held unconverted, and NULL says exactly that.
--
-- `reserve_coupon` takes the rate and both snapshots, and refuses a coupon
-- carrying money in another currency with no rate — the last line behind the
-- validation that already refused it as `currency_unavailable`. The argument
-- list changes, so it is dropped and made again from
-- `20260928003100_a_coupon_redemption_records_its_currency` with that check and
-- the insert changed, and its grant restored.
--
-- Rollback: drop the nine-argument function, re-apply the six-argument one
-- from 20260928003100, then drop the four columns.

ALTER TABLE "billing"."coupon_redemption"
  ADD COLUMN "fxFromCode" TEXT,
  ADD COLUMN "fxRate" DECIMAL(30,18),
  ADD COLUMN "fxSnapshotId" UUID,
  ADD COLUMN "fxFromSnapshotId" UUID,
  ADD CONSTRAINT "coupon_redemption_fx_is_whole"
    CHECK (("fxRate" IS NULL) = ("fxFromCode" IS NULL)
           AND ("fxRate" IS NOT NULL OR ("fxSnapshotId" IS NULL AND "fxFromSnapshotId" IS NULL))),
  ADD CONSTRAINT "coupon_redemption_fx_rate_positive" CHECK ("fxRate" > 0),
  ADD CONSTRAINT "coupon_redemption_fx_from_code_shape" CHECK ("fxFromCode" ~ '^[A-Z]{3}$' AND "fxFromCode" <> "currencyCode");

ALTER TABLE "billing"."coupon_redemption"
  ADD CONSTRAINT "coupon_redemption_fxSnapshotId_fkey"
  FOREIGN KEY ("fxSnapshotId") REFERENCES "currency"."currency_exchange_rate"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "coupon_redemption_fxFromSnapshotId_fkey"
  FOREIGN KEY ("fxFromSnapshotId") REFERENCES "currency"."currency_exchange_rate"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DROP FUNCTION billing.reserve_coupon(uuid, uuid, uuid, uuid, numeric, text);

CREATE FUNCTION billing.reserve_coupon(
  p_coupon_id uuid,
  p_user_id uuid,
  p_order_reference_id uuid,
  p_payment_transaction_id uuid,
  p_discount numeric,
  p_currency_code text,
  p_fx_rate numeric,
  p_fx_snapshot_id uuid,
  p_fx_from_snapshot_id uuid
) RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  c billing.coupon%ROWTYPE;
  v_live integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'reserve_coupon: no tenant bound on this transaction';
  END IF;
  IF p_discount IS NULL OR p_discount <= 0 OR p_discount <> round(p_discount, 2) THEN
    RAISE EXCEPTION 'reserve_coupon: discount must be > 0 in cents';
  END IF;

  -- ADR-0048: the caller's own coupon, or a platform coupon that serves its
  -- tenant; never a soft-deleted one.
  SELECT * INTO c FROM billing.coupon
   WHERE id = p_coupon_id
     AND ("tenantId" = v_tenant
          OR ("tenantId" IS NULL AND billing.platform_coupon_serves(id, v_tenant)))
     AND "deletedAt" IS NULL
     FOR UPDATE;

  IF NOT FOUND OR NOT c."isActive" THEN
    RETURN 'not_found';
  END IF;
  IF c.visibility = 'targeted' AND NOT EXISTS (
    SELECT 1 FROM billing.coupon_allowed_user
     WHERE "couponId" = c.id AND "userId" = p_user_id
  ) THEN
    RETURN 'not_found';
  END IF;
  -- F-502-l-a: a free-service code is redeemed in the gift box too, never priced here.
  IF c."discountType"::text IN ('wallet_credit', 'free_grant') THEN
    RETURN 'not_a_discount';
  END IF;
  -- F-116-h6: money in the coupon's currency is never held as if it were in
  -- the order's. A coupon that carries any needs the rate it was converted at.
  IF p_fx_rate IS NULL AND c."currencyCode" <> p_currency_code
     AND (c."discountType" = 'fixed_amount' OR c."maxDiscountCap" IS NOT NULL
          OR c."minPurchaseAmount" IS NOT NULL OR c."maxPurchaseAmount" IS NOT NULL) THEN
    RAISE EXCEPTION 'reserve_coupon: coupon % is in %, the order in %, and no rate was given',
      c.id, c."currencyCode", p_currency_code;
  END IF;
  IF c."validFrom" IS NOT NULL AND c."validFrom" > now() THEN
    RETURN 'not_started';
  END IF;
  IF c."expiresAt" IS NOT NULL AND c."expiresAt" <= now() THEN
    RETURN 'expired';
  END IF;
  -- 0 is unlimited (the user, 2026-09-11).
  IF c."perUserUsageLimit" > 0 THEN
    SELECT count(*) INTO v_live FROM billing.coupon_redemption
     WHERE "couponId" = c.id AND "userId" = p_user_id AND status IN ('pending', 'confirmed');
    IF v_live >= c."perUserUsageLimit" THEN
      RETURN 'per_user_limit_reached';
    END IF;
  END IF;
  -- F-502-k: the period limit, counted under the same lock as the per-user one.
  IF c."periodUsageLimit" IS NOT NULL THEN
    SELECT count(*) INTO v_live FROM billing.coupon_redemption
     WHERE "couponId" = c.id AND "userId" = p_user_id AND status IN ('pending', 'confirmed')
       AND "redeemedAt" > now() - make_interval(days => c."periodDays");
    IF v_live >= c."periodUsageLimit" THEN
      RETURN 'period_limit_reached';
    END IF;
  END IF;
  -- F-502-k: a first purchase is one with no `success` payment before it and
  -- no live hold of a first-purchase coupon on another order.
  IF c."firstPurchaseOnly" AND (
       EXISTS (SELECT 1 FROM billing.payment_transaction
                WHERE "userId" = p_user_id AND status = 'success'
                  AND id IS DISTINCT FROM p_payment_transaction_id)
    OR EXISTS (SELECT 1 FROM billing.coupon_redemption r
                 JOIN billing.coupon fc ON fc.id = r."couponId"
                WHERE r."userId" = p_user_id AND r.status IN ('pending', 'confirmed')
                  AND fc."firstPurchaseOnly" AND r."orderReferenceId" <> p_order_reference_id)
  ) THEN
    RETURN 'first_purchase_only';
  END IF;
  IF c."totalUsageLimit" IS NOT NULL AND c."usedCount" + c."reservedCount" >= c."totalUsageLimit" THEN
    RETURN 'capacity_reached';
  END IF;

  UPDATE billing.coupon SET "reservedCount" = "reservedCount" + 1 WHERE id = c.id;
  INSERT INTO billing.coupon_redemption
    (id, "couponId", "userId", status, "paymentTransactionId", "discountAppliedAmount", "currencyCode", "orderReferenceId",
     "fxFromCode", "fxRate", "fxSnapshotId", "fxFromSnapshotId")
  VALUES
    (gen_random_uuid(), c.id, p_user_id, 'pending', p_payment_transaction_id, p_discount, p_currency_code, p_order_reference_id,
     CASE WHEN p_fx_rate IS NULL THEN NULL ELSE c."currencyCode" END, p_fx_rate, p_fx_snapshot_id, p_fx_from_snapshot_id);
  RETURN 'reserved';
END
$$;

REVOKE ALL ON FUNCTION billing.reserve_coupon(uuid, uuid, uuid, uuid, numeric, text, numeric, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.reserve_coupon(uuid, uuid, uuid, uuid, numeric, text, numeric, uuid, uuid) TO txnet_app;
