-- F-502-l-a (D-35) — a `free_grant` coupon: it gives a Grant of one catalog
-- variant instead of money. Hand-written in part: Prisma cannot express a CHECK
-- or a function.
--
-- 1. `DiscountType` gains `free_grant`.
-- 2. `coupon.grantVariantId` names the variant; a CHECK holds that a
--    `free_grant` coupon names one and no other type does, and another that it
--    carries no value. Both compare the type as text: Postgres will not use an
--    enum value added in the same transaction.
-- 3. `reserve_coupon` answers `not_a_discount` for it, as for a gift code. The
--    function is `20260914001200_coupon_limit_gates`' with that one line
--    changed; `redeem_gift_coupon` still refuses it until F-502-l-b.
--
-- Rollback: re-apply `reserve_coupon` from `20260914001200`; drop the two CHECKs,
-- the FK and the column. Postgres cannot drop an enum value.

ALTER TYPE "catalog"."DiscountType" ADD VALUE IF NOT EXISTS 'free_grant';

ALTER TABLE "billing"."coupon" ADD COLUMN "grantVariantId" UUID;
ALTER TABLE "billing"."coupon" ADD CONSTRAINT "coupon_grantVariantId_fkey"
  FOREIGN KEY ("grantVariantId") REFERENCES "catalog"."product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing"."coupon" ADD CONSTRAINT "coupon_free_grant_names_variant"
  CHECK (("discountType"::text = 'free_grant') = ("grantVariantId" IS NOT NULL));
ALTER TABLE "billing"."coupon" ADD CONSTRAINT "coupon_free_grant_has_no_value"
  CHECK ("discountType"::text <> 'free_grant' OR "discountValue" = 0);

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
  -- F-502-l-a: a free-service code is redeemed in the gift box too, never priced here.
  IF c."discountType"::text IN ('wallet_credit', 'free_grant') THEN
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
