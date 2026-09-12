-- Gift code redemption (F-092-m, D-21). Hand-written for the reason
-- `20260911000200_coupon_reservation` gives: Prisma cannot express a function,
-- and a tenant's connection may read a platform coupon but its RLS `WITH CHECK`
-- refuses to update one — not even its counters. Additive: no table or column
-- changes, and `reserve_coupon` / `settle_coupon_redemptions` are untouched.
--
-- Why not `reserve_coupon`. A gift code is a `wallet_credit` coupon, which that
-- function refuses by name (`not_a_discount`), and rightly: a discount is held
-- while a payment runs and confirmed when it lands. A gift has no payment. It
-- is taken and used in the same statement, inside the same transaction that
-- credits the wallet, so there is never a `pending` row that a lost callback
-- could strand. Bending `reserve_coupon` into both shapes would put the branch
-- in the one place where the last slot is decided.
--
-- What is shared with it, deliberately identically: the row lock taken before
-- any count, the gate order, `0` as an unlimited per-user limit, and writing
-- nothing at all when a gate refuses.
--
-- Rollback: `DROP FUNCTION billing.redeem_gift_coupon(text, uuid)`.

DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'gift redemption needs an owner that bypasses RLS; % does not', current_user;
  END IF;
END
$$;

-- Uses one gift code for one user. Returns ('redeemed', the redemption row's
-- id, the amount to credit), or the refusal that stopped it — in which case it
-- wrote nothing and both other columns are NULL.
--
-- The caller credits the wallet in this same transaction. It must not commit
-- unless that credit lands: the redemption is what makes the code spent.
CREATE FUNCTION billing.redeem_gift_coupon(
  p_code text,
  p_user_id uuid
) RETURNS TABLE (outcome text, redemption_id uuid, credited numeric)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  c billing.coupon%ROWTYPE;
  v_live integer;
  v_id uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'redeem_gift_coupon: no tenant bound on this transaction';
  END IF;
  IF p_code IS NULL OR p_code = '' THEN
    RAISE EXCEPTION 'redeem_gift_coupon: a code is required';
  END IF;

  -- By code, because a gift code is what the user has; `coupon.code` is unique
  -- platform-wide, so this locks at most one row.
  SELECT * INTO c FROM billing.coupon
   WHERE code = p_code
     AND ("tenantId" IS NULL OR "tenantId" = v_tenant)
     FOR UPDATE;

  IF NOT FOUND OR NOT c."isActive" THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::numeric;
    RETURN;
  END IF;
  IF c.visibility = 'targeted' AND NOT EXISTS (
    SELECT 1 FROM billing.coupon_allowed_user
     WHERE "couponId" = c.id AND "userId" = p_user_id
  ) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::numeric;
    RETURN;
  END IF;
  -- The mirror of `reserve_coupon`'s `not_a_discount`: each box refuses the
  -- other's code by name, so the panel can say which box it belongs in.
  IF c."discountType" <> 'wallet_credit' THEN
    RETURN QUERY SELECT 'not_a_gift_code'::text, NULL::uuid, NULL::numeric;
    RETURN;
  END IF;
  IF c."expiresAt" IS NOT NULL AND c."expiresAt" <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::numeric;
    RETURN;
  END IF;
  -- 0 is unlimited (the user, 2026-09-11). `confirmed` alone would do here —
  -- a gift writes no `pending` row — but a coupon may be both, and billing
  -- invariant 6 counts every live redemption.
  IF c."perUserUsageLimit" > 0 THEN
    SELECT count(*) INTO v_live FROM billing.coupon_redemption
     WHERE "couponId" = c.id AND "userId" = p_user_id AND status IN ('pending', 'confirmed');
    IF v_live >= c."perUserUsageLimit" THEN
      RETURN QUERY SELECT 'per_user_limit_reached'::text, NULL::uuid, NULL::numeric;
      RETURN;
    END IF;
  END IF;
  IF c."totalUsageLimit" IS NOT NULL AND c."usedCount" + c."reservedCount" >= c."totalUsageLimit" THEN
    RETURN QUERY SELECT 'capacity_reached'::text, NULL::uuid, NULL::numeric;
    RETURN;
  END IF;

  -- An admin's broken row, never a user's mistake — so it raises rather than
  -- returning a refusal the panel would show as "your code is invalid".
  IF c."discountValue" <= 0 OR c."discountValue" <> round(c."discountValue", 2) THEN
    RAISE EXCEPTION 'redeem_gift_coupon: coupon % carries a credit that is not > 0 in cents', c.code;
  END IF;

  v_id := gen_random_uuid();
  -- `usedCount`, not `reservedCount`: nothing is held. `orderReferenceId` is
  -- the redemption's own id — the column is required and a gift has no order,
  -- and self-reference keeps `settle_coupon_redemptions` a no-op over it
  -- (it moves `pending` rows only).
  UPDATE billing.coupon SET "usedCount" = "usedCount" + 1 WHERE id = c.id;
  INSERT INTO billing.coupon_redemption
    (id, "couponId", "userId", status, "paymentTransactionId", "discountAppliedAmount", "orderReferenceId")
  VALUES
    (v_id, c.id, p_user_id, 'confirmed', NULL, c."discountValue", v_id);

  RETURN QUERY SELECT 'redeemed'::text, v_id, c."discountValue";
END
$$;

REVOKE ALL ON FUNCTION billing.redeem_gift_coupon(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.redeem_gift_coupon(text, uuid) TO txnet_app;
