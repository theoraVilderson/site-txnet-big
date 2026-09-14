-- F-092-ah (ADR-0047 decision 3) — how many coupons stand past their limit.
-- Hand-written: Prisma cannot express a function. Additive.
--
-- A late credit claims a coupon use back without a limit check (ADR-0046
-- decision 1), and since F-092-ah that can happen only for a charge later than
-- COUPON_HOLD_AFTER_EXPIRY_SEC. It stays allowed; it must not stay silent.
--
-- Why a SECURITY DEFINER function and not a query. `postgres-exporter` connects
-- as `txnet_app_user`, and `billing.coupon`'s RLS shows a connection with no
-- tenant bound only the platform-wide coupons — a reseller's coupon over its
-- limit would read zero. This answers one number across every tenant and
-- nothing else: no code, no tenant, no row.
--
-- Rollback: `DROP FUNCTION billing.coupons_over_limit()`.

CREATE FUNCTION billing.coupons_over_limit() RETURNS integer
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT count(*)::integer
    FROM billing.coupon
   WHERE "totalUsageLimit" IS NOT NULL
     AND "usedCount" > "totalUsageLimit"
$$;

REVOKE ALL ON FUNCTION billing.coupons_over_limit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.coupons_over_limit() TO txnet_app;
