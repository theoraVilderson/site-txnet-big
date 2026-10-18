-- F-513-b: billing writes a variant's sales counts (catalog F-513).
--
-- 1. `catalog.move_variant_sales` is the counts' only writer. It is SECURITY
--    DEFINER because a reseller's users buy the platform's variants, and
--    `tenant_isolation`'s WITH CHECK refuses a reseller's transaction writing a
--    platform row. It writes nothing else on the row, and only a variant the
--    bound tenant can see (its own or the platform's), as RLS would read it.
-- 2. The row lock is the UPDATE's own: two buyers of the last unit queue on it,
--    and the second re-reads the counts the first committed.
-- 3. `invoice.salesCounted`: whether this invoice is in its variant's counts —
--    held while `pending`, sold once `paid`. Every invoice made before this
--    migration is false, so its expiry, cancel or refund gives back nothing it
--    never took.
-- Additive; rollback: drop the function and the column.

DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'move_variant_sales needs an owner that bypasses RLS; % does not', current_user;
  END IF;
END
$$;

ALTER TABLE "billing"."invoice" ADD COLUMN "salesCounted" BOOLEAN NOT NULL DEFAULT false;

-- Moves the counts by one sale or one hold, each delta -1, 0 or 1. With
-- p_refuse_when_full, a move that takes a unit is refused when none is left —
-- outcome 'sold_out', nothing written. Returns the counts after the move, and
-- the variant's tenant, for the caller's event.
CREATE FUNCTION catalog.move_variant_sales(
  p_variant_id uuid,
  p_sold_delta integer,
  p_reserved_delta integer,
  p_refuse_when_full boolean
) RETURNS TABLE (outcome text, "tenantId" uuid, "salesCap" integer, "soldCount" integer, "reservedCount" integer)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v catalog.product_variant%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'move_variant_sales: no tenant bound on this transaction';
  END IF;
  IF p_sold_delta NOT IN (-1, 0, 1) OR p_reserved_delta NOT IN (-1, 0, 1) THEN
    RAISE EXCEPTION 'move_variant_sales: a move is one unit';
  END IF;

  SELECT * INTO v FROM catalog.product_variant
   WHERE id = p_variant_id
     AND ("tenantId" = v_tenant OR "tenantId" = public.platform_tenant_id())
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  -- A unit is taken when the move adds to sold + held; a hold becoming a sale takes none.
  IF p_refuse_when_full AND p_sold_delta + p_reserved_delta > 0 AND v."salesCap" IS NOT NULL
     AND v."soldCount" + v."reservedCount" >= v."salesCap" THEN
    RETURN QUERY SELECT 'sold_out'::text, v."tenantId", v."salesCap", v."soldCount", v."reservedCount";
    RETURN;
  END IF;

  -- The counts' CHECK (>= 0) refuses a give-back of what was never taken: a bug, never floored.
  RETURN QUERY
  UPDATE catalog.product_variant p
     SET "soldCount" = p."soldCount" + p_sold_delta,
         "reservedCount" = p."reservedCount" + p_reserved_delta
   WHERE p.id = p_variant_id
  RETURNING 'moved'::text, p."tenantId", p."salesCap", p."soldCount", p."reservedCount";
END
$$;

REVOKE ALL ON FUNCTION catalog.move_variant_sales(uuid, integer, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.move_variant_sales(uuid, integer, integer, boolean) TO txnet_app;
