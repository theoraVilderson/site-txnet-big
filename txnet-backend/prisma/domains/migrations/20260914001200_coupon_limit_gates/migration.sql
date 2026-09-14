-- F-502-k (D-33) — `reserve_coupon` re-checks, under its row lock, the limits
-- whose answer another purchase can change between the quote and the hold: the
-- start date, the per-period limit and first purchase only. Hand-written:
-- Prisma cannot express a function. `CREATE OR REPLACE` with the signature of
-- `20260914001000_coupon_scope_in_functions`, so no grant or caller changes.
--
-- Not re-checked here, deliberately: the weekday and hour window, the channel,
-- the gateway, the maximum purchase and the new-user window. Validation ran
-- them seconds earlier in the same request; none of them is a count another
-- buyer can move, and the window is a clock edge nobody can race for money.
--
-- The first-purchase check is exact for one coupon (the lock) and best-effort
-- across two different first-purchase coupons held at the same instant on two
-- orders: each lock is its own coupon's. Accepted in F-502-k.
--
-- Rollback: re-apply `reserve_coupon` from `20260914001000_coupon_scope_in_functions`.

CREATE OR REPLACE FUNCTION billing.reserve_coupon(
  p_coupon_id uuid,
  p_user_id uuid,
  p_order_reference_id uuid,
  p_payment_transaction_id uuid,
  p_discount numeric
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
  IF c."discountType" = 'wallet_credit' THEN
    RETURN 'not_a_discount';
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
    (id, "couponId", "userId", status, "paymentTransactionId", "discountAppliedAmount", "orderReferenceId")
  VALUES
    (gen_random_uuid(), c.id, p_user_id, 'pending', p_payment_transaction_id, p_discount, p_order_reference_id);
  RETURN 'reserved';
END
$$;
