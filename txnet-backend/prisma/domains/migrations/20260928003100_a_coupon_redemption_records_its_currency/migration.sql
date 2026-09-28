-- F-116-h5 (ADR-0098 part 3) — a coupon redemption records its currency.
--
-- Before this, `discountAppliedAmount` was a bare number: a tenant that moved
-- USD -> IRR (F-116-f) reported old dollar and new rial discounts summed as
-- one. The column says what each row is in, and the usage report totals each
-- currency on its own (`coupon-usage.service.ts`).
--
-- Backfill, most exact first:
--   1. the order's own row, which records its currency since F-116-b: the
--      invoice whose id is `orderReferenceId`, else the payment
--      (`paymentTransactionId`, or `orderReferenceId` for a top-up);
--   2. otherwise (a gift code, whose order is itself) the owner tenant's
--      currency when it was redeemed: the `fromCode` of its first
--      `currency_change` after `redeemedAt` — the platform owner's for a
--      platform coupon;
--   3. otherwise, no change since: the coupon's currency now.
-- Then NOT NULL with no default: a writer that does not say is refused.
--
-- The writers: `reserve_coupon` takes the order's currency from its caller
-- (the discount is part of the order's amount, which the caller priced); the
-- argument list changes, so it is dropped and made again from
-- `20260915000100_coupon_free_grant` with that one insert changed, and its
-- grant restored. `redeem_gift_coupon` writes the coupon's own currency: the
-- same signature, from `20260915000200_gift_redeems_free_grant`.
--
-- Rollback: re-apply both functions from those migrations (`reserve_coupon`
-- after dropping the six-argument one), then drop the column.

ALTER TABLE "billing"."coupon_redemption" ADD COLUMN "currencyCode" TEXT;

UPDATE billing.coupon_redemption r
   SET "currencyCode" = i."currencyCode"
  FROM billing.invoice i
 WHERE i.id = r."orderReferenceId" AND r."currencyCode" IS NULL;

UPDATE billing.coupon_redemption r
   SET "currencyCode" = p."currencyCode"
  FROM billing.payment_transaction p
 WHERE p.id = COALESCE(r."paymentTransactionId", r."orderReferenceId") AND r."currencyCode" IS NULL;

UPDATE billing.coupon_redemption r
   SET "currencyCode" = COALESCE(
         (SELECT ch."fromCode"
            FROM billing.currency_change ch
           WHERE ch."tenantId" = COALESCE(c."tenantId",
                   (SELECT t.id FROM tenant.tenant t WHERE t."tenantType" = 'platform_owner' LIMIT 1))
             AND ch."createdAt" > r."redeemedAt"
           ORDER BY ch."createdAt"
           LIMIT 1),
         c."currencyCode")
  FROM billing.coupon c
 WHERE c.id = r."couponId" AND r."currencyCode" IS NULL;

ALTER TABLE "billing"."coupon_redemption"
    ALTER COLUMN "currencyCode" SET NOT NULL,
    ADD CONSTRAINT "coupon_redemption_currency_code_shape" CHECK ("currencyCode" ~ '^[A-Z]{3}$');

DROP FUNCTION billing.reserve_coupon(uuid, uuid, uuid, uuid, numeric);

CREATE FUNCTION billing.reserve_coupon(
  p_coupon_id uuid,
  p_user_id uuid,
  p_order_reference_id uuid,
  p_payment_transaction_id uuid,
  p_discount numeric,
  p_currency_code text
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
    (id, "couponId", "userId", status, "paymentTransactionId", "discountAppliedAmount", "currencyCode", "orderReferenceId")
  VALUES
    (gen_random_uuid(), c.id, p_user_id, 'pending', p_payment_transaction_id, p_discount, p_currency_code, p_order_reference_id);
  RETURN 'reserved';
END
$$;

REVOKE ALL ON FUNCTION billing.reserve_coupon(uuid, uuid, uuid, uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.reserve_coupon(uuid, uuid, uuid, uuid, numeric, text) TO txnet_app;

CREATE OR REPLACE FUNCTION billing.redeem_gift_coupon(
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
  -- F-116-h5: a gift is in its coupon's currency, which the wallet it credits must keep.
  INSERT INTO billing.coupon_redemption
    (id, "couponId", "userId", status, "paymentTransactionId", "discountAppliedAmount", "currencyCode", "orderReferenceId")
  VALUES
    (v_id, c.id, p_user_id, 'confirmed', NULL, c."discountValue", c."currencyCode", v_id);

  -- A free service answers its variant; the caller issues the Grant in this transaction.
  RETURN QUERY SELECT 'redeemed'::text, v_id, c."discountValue", c."grantVariantId";
END
$$;
