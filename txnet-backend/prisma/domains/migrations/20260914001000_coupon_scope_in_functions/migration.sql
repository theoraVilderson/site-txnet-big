-- F-502-b (D-33, ADR-0048) — the two SQL doors that read a coupon past RLS
-- honour F-502-a's scope. Hand-written: Prisma cannot express a function.
-- `CREATE OR REPLACE` with identical signatures, so no grant changes and no
-- caller changes.
--
-- Both functions run as their owner and never see `billing.coupon`'s policy,
-- so each spelled the old read side itself: `tenantId IS NULL OR mine`. That is
-- now `mine OR (NULL AND billing.platform_coupon_serves(id, mine))`, and a
-- soft-deleted coupon is refused as unknown. Everything else — the lock, the
-- gate order, the counters — is byte for byte what it replaces.
--
-- `settle_coupon_redemptions` and `claim_expired_coupon_redemptions` keep the
-- old scope on purpose: they finish a hold already taken, and a coupon whose
-- scope changed after the hold must still give its slot back.
--
-- Rollback: re-apply the function bodies from `20260911000200_coupon_reservation`
-- and `20260912000000_gift_code_redemption`.

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

CREATE OR REPLACE FUNCTION billing.redeem_gift_coupon(
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

  -- By code, which is unique only inside a tenant now (ADR-0048): the
  -- caller's own coupon wins over a platform coupon that serves its tenant and
  -- shares the code (decision 5), so this still locks at most one row.
  SELECT * INTO c FROM billing.coupon
   WHERE code = p_code
     AND ("tenantId" = v_tenant
          OR ("tenantId" IS NULL AND billing.platform_coupon_serves(id, v_tenant)))
     AND "deletedAt" IS NULL
   ORDER BY ("tenantId" IS NULL)
   LIMIT 1
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
