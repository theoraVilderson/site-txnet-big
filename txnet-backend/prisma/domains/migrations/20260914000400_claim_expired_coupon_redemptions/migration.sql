-- F-092-aa (ADR-0046 decision 1) — a payment the gateway confirms after its
-- clock ran out is credited, and the coupon uses the expiry sweep released are
-- claimed back. Hand-written: Prisma cannot express a function. Additive.
--
-- Why a second function and not a new outcome of `settle_coupon_redemptions`.
-- That one moves only `pending` holds, which is what makes a duplicate callback
-- or a late expiry move nothing; widening its source would let a `confirmed`
-- call reopen an `expired` hold on any path. This one moves only `expired`
-- rows, and only its single caller — the crediting transaction that just
-- flipped the payment from `expired` — reaches it.
--
-- Why no limit check. The slot was given back when the clock ran out, and may
-- have been taken since. The payer was charged the discounted price, so the use
-- is recorded even if `usedCount` passes `maxUses`: refusing money already paid
-- over a counter is the worse error, and an over-limit count stays visible.
--
-- Security as in 20260911000200_coupon_reservation: SECURITY DEFINER, scoped to
-- the coupons the bound tenant can see, callable only by txnet_app.
--
-- Rollback: `DROP FUNCTION billing.claim_expired_coupon_redemptions(uuid)`.

CREATE FUNCTION billing.claim_expired_coupon_redemptions(
  p_order_reference_id uuid
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
    RAISE EXCEPTION 'claim_expired_coupon_redemptions: no tenant bound on this transaction';
  END IF;

  -- The lock order `reserve_coupon` uses, so a claim cannot deadlock a reservation.
  PERFORM 1 FROM billing.coupon c
   WHERE c.id IN (
       SELECT "couponId" FROM billing.coupon_redemption
        WHERE "orderReferenceId" = p_order_reference_id AND status = 'expired')
     AND (c."tenantId" IS NULL OR c."tenantId" = v_tenant)
   ORDER BY c.id
     FOR UPDATE;

  WITH moved AS (
    UPDATE billing.coupon_redemption r
       SET status = 'confirmed'
      FROM billing.coupon c
     WHERE r."orderReferenceId" = p_order_reference_id
       AND r.status = 'expired'
       AND c.id = r."couponId"
       AND (c."tenantId" IS NULL OR c."tenantId" = v_tenant)
    RETURNING r."couponId"
  ), per_coupon AS (
    SELECT "couponId", count(*)::integer AS n FROM moved GROUP BY "couponId"
  ), counted AS (
    -- `reservedCount` is untouched: the sweep already took these out of it.
    UPDATE billing.coupon c
       SET "usedCount" = c."usedCount" + p.n
      FROM per_coupon p
     WHERE c.id = p."couponId"
    RETURNING p.n
  )
  SELECT coalesce(sum(n), 0)::integer INTO v_moved FROM counted;

  RETURN v_moved;
END
$$;

REVOKE ALL ON FUNCTION billing.claim_expired_coupon_redemptions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.claim_expired_coupon_redemptions(uuid) TO txnet_app;
