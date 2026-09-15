-- F-502-l-b (D-35) — the gift box redeems a `free_grant` code too.
-- `redeem_gift_coupon` runs the same gates under the same row lock, marks the
-- code used with a `confirmed` redemption of 0, and answers the coupon's
-- `grantVariantId`; `GiftRedemptionService` issues the Grant in the same
-- transaction (`source = coupon`, `sourceReferenceId` = the redemption row).
-- A `wallet_credit` code is redeemed exactly as before.
--
-- The answer gains a column, which `CREATE OR REPLACE` cannot do: the function
-- is dropped and made again from `20260914001000_coupon_scope_in_functions`
-- with those lines changed, and its grant restored.
--
-- Rollback: drop it and re-apply `redeem_gift_coupon` from `20260914001000`
-- with that migration's grant.

DROP FUNCTION billing.redeem_gift_coupon(text, uuid);

CREATE FUNCTION billing.redeem_gift_coupon(
  p_code text,
  p_user_id uuid
) RETURNS TABLE (outcome text, redemption_id uuid, credited numeric, grant_variant_id uuid)
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
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::numeric, NULL::uuid;
    RETURN;
  END IF;
  IF c.visibility = 'targeted' AND NOT EXISTS (
    SELECT 1 FROM billing.coupon_allowed_user
     WHERE "couponId" = c.id AND "userId" = p_user_id
  ) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::numeric, NULL::uuid;
    RETURN;
  END IF;
  -- The mirror of `reserve_coupon`'s `not_a_discount`: each box refuses the
  -- other's code by name, so the panel can say which box it belongs in.
  -- F-502-l-b: a free-service code is redeemed here too, into a Grant.
  IF c."discountType"::text NOT IN ('wallet_credit', 'free_grant') THEN
    RETURN QUERY SELECT 'not_a_gift_code'::text, NULL::uuid, NULL::numeric, NULL::uuid;
    RETURN;
  END IF;
  IF c."expiresAt" IS NOT NULL AND c."expiresAt" <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::numeric, NULL::uuid;
    RETURN;
  END IF;
  -- 0 is unlimited (the user, 2026-09-11). `confirmed` alone would do here —
  -- a gift writes no `pending` row — but a coupon may be both, and billing
  -- invariant 6 counts every live redemption.
  IF c."perUserUsageLimit" > 0 THEN
    SELECT count(*) INTO v_live FROM billing.coupon_redemption
     WHERE "couponId" = c.id AND "userId" = p_user_id AND status IN ('pending', 'confirmed');
    IF v_live >= c."perUserUsageLimit" THEN
      RETURN QUERY SELECT 'per_user_limit_reached'::text, NULL::uuid, NULL::numeric, NULL::uuid;
      RETURN;
    END IF;
  END IF;
  IF c."totalUsageLimit" IS NOT NULL AND c."usedCount" + c."reservedCount" >= c."totalUsageLimit" THEN
    RETURN QUERY SELECT 'capacity_reached'::text, NULL::uuid, NULL::numeric, NULL::uuid;
    RETURN;
  END IF;

  -- An admin's broken row, never a user's mistake — so it raises rather than
  -- returning a refusal the panel would show as "your code is invalid".
  IF c."discountType"::text = 'wallet_credit'
     AND (c."discountValue" <= 0 OR c."discountValue" <> round(c."discountValue", 2)) THEN
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

  -- A free service answers its variant; the caller issues the Grant in this transaction.
  RETURN QUERY SELECT 'redeemed'::text, v_id, c."discountValue", c."grantVariantId";
END
$$;

REVOKE ALL ON FUNCTION billing.redeem_gift_coupon(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.redeem_gift_coupon(text, uuid) TO txnet_app;
