-- Coupon reservation (F-092-h, ADR-0040). Hand-written: Prisma cannot express
-- a function. Additive — no table or column changes.
--
-- Why functions and not plain queries from the service. `billing.coupon` is
-- shared-read (`20260909001500_row_level_security_all_tables`): a tenant's
-- connection sees its own coupons and the platform's (`tenantId` NULL), but its
-- `WITH CHECK` is strict, so it cannot update a platform coupon — not even its
-- counters. Relaxing the policy would let a tenant rewrite a platform coupon's
-- discount. These functions run as their owner and change nothing but
-- `usedCount`, `reservedCount` and `coupon_redemption`, and only for a coupon
-- the caller's bound tenant can see.
--
-- Why a lock and not a count. Legacy counted live holds, then wrote, so two
-- buyers both took the last slot. `reserve_coupon` locks the coupon row first;
-- a second reservation waits on it, and its checks then run as new statements
-- that see the first one's committed hold (READ COMMITTED). The per-user limit
-- (billing invariant 6) is counted under the same lock.
--
-- Rollback: `DROP FUNCTION billing.reserve_coupon(uuid, uuid, uuid, uuid, numeric),
-- billing.settle_coupon_redemptions(uuid, billing."RedemptionStatus")`.

-- The owner must be able to write a platform coupon past FORCE ROW LEVEL
-- SECURITY. `prisma migrate` runs as the superuser (`scripts/db-login-roles.sh`);
-- asserted rather than assumed, because under any other owner the first
-- reservation of a platform coupon would fail, not this migration.
DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'coupon reservation functions need an owner that bypasses RLS; % does not', current_user;
  END IF;
END
$$;

-- Takes one hold of one coupon for one order. Returns 'reserved', or the
-- `CouponRejection` that refused it — in which case it wrote nothing.
CREATE FUNCTION billing.reserve_coupon(
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

  SELECT * INTO c FROM billing.coupon
   WHERE id = p_coupon_id
     AND ("tenantId" IS NULL OR "tenantId" = v_tenant)
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

-- Finishes an order's pending holds: 'confirmed' turns each into a use,
-- 'cancelled' or 'expired' gives its slot back. Only `pending` rows move, so a
-- second call — a duplicate callback, a late expiry — moves nothing. Returns
-- how many moved.
CREATE FUNCTION billing.settle_coupon_redemptions(
  p_order_reference_id uuid,
  p_outcome billing."RedemptionStatus"
) RETURNS integer
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v_moved integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'settle_coupon_redemptions: no tenant bound on this transaction';
  END IF;
  IF p_outcome IS NULL OR p_outcome = 'pending' THEN
    RAISE EXCEPTION 'settle_coupon_redemptions: outcome must be confirmed, cancelled or expired';
  END IF;

  -- Coupon rows in id order, the order `reserve` takes them in, so two orders
  -- stacking the same codes cannot deadlock.
  PERFORM 1 FROM billing.coupon c
   WHERE c.id IN (
       SELECT "couponId" FROM billing.coupon_redemption
        WHERE "orderReferenceId" = p_order_reference_id AND status = 'pending')
     AND (c."tenantId" IS NULL OR c."tenantId" = v_tenant)
   ORDER BY c.id
     FOR UPDATE;

  WITH moved AS (
    UPDATE billing.coupon_redemption r
       SET status = p_outcome
      FROM billing.coupon c
     WHERE r."orderReferenceId" = p_order_reference_id
       AND r.status = 'pending'
       AND c.id = r."couponId"
       AND (c."tenantId" IS NULL OR c."tenantId" = v_tenant)
    RETURNING r."couponId"
  ), per_coupon AS (
    SELECT "couponId", count(*)::integer AS n FROM moved GROUP BY "couponId"
  ), counted AS (
    UPDATE billing.coupon c
       SET "reservedCount" = c."reservedCount" - p.n,
           "usedCount" = c."usedCount" + CASE WHEN p_outcome = 'confirmed' THEN p.n ELSE 0 END
      FROM per_coupon p
     WHERE c.id = p."couponId"
    RETURNING p.n
  )
  SELECT coalesce(sum(n), 0)::integer INTO v_moved FROM counted;

  RETURN v_moved;
END
$$;

REVOKE ALL ON FUNCTION billing.reserve_coupon(uuid, uuid, uuid, uuid, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing.settle_coupon_redemptions(uuid, billing."RedemptionStatus") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.reserve_coupon(uuid, uuid, uuid, uuid, numeric) TO txnet_app;
GRANT EXECUTE ON FUNCTION billing.settle_coupon_redemptions(uuid, billing."RedemptionStatus") TO txnet_app;
