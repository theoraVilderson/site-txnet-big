-- LIVE-1-w (2026-10-28): the variant's row lock is FOR NO KEY UPDATE, the
-- mode its own UPDATE takes anyway. Thirty payers of one variant deadlocked
-- (40P01) when each held the KEY SHARE its Grant's foreign key takes and then
-- asked this function for the stronger lock; a KEY SHARE does not block this
-- one, so a payment may move its sale after inserting its Grant and hold the
-- row only to its commit. Movers still queue on one another exactly as before,
-- so the active cap's count under the lock (20261018000900, point 2) holds.
-- Same signature and result: CREATE OR REPLACE. No data is touched.
-- Rollback: re-create 20261018000900's function.

DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'move_variant_sales needs an owner that bypasses RLS; % does not', current_user;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION catalog.move_variant_sales(
  p_variant_id uuid,
  p_sold_delta integer,
  p_reserved_delta integer,
  p_refuse_when_full boolean
) RETURNS TABLE (outcome text, "tenantId" uuid, "salesCap" integer, "activeCap" integer, "soldCount" integer, "reservedCount" integer)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
  v catalog.product_variant%ROWTYPE;
  v_live integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'move_variant_sales: no tenant bound on this transaction';
  END IF;
  IF p_sold_delta NOT IN (-1, 0, 1) OR p_reserved_delta NOT IN (-1, 0, 1) THEN
    RAISE EXCEPTION 'move_variant_sales: a move is one unit';
  END IF;

  SELECT p.* INTO v FROM catalog.product_variant p
   WHERE p.id = p_variant_id
     AND (p."tenantId" = v_tenant OR p."tenantId" = public.platform_tenant_id())
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer, NULL::integer, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  -- A unit is taken when the move adds to sold + held; a hold becoming a sale takes none.
  IF p_refuse_when_full AND p_sold_delta + p_reserved_delta > 0 THEN
    IF v."salesCap" IS NOT NULL AND v."soldCount" + v."reservedCount" >= v."salesCap" THEN
      RETURN QUERY SELECT 'sold_out'::text, v."tenantId", v."salesCap", v."activeCap", v."soldCount", v."reservedCount";
      RETURN;
    END IF;
    IF v."activeCap" IS NOT NULL THEN
      -- Its own statement, so its snapshot is taken under the lock (20261018000900, 2).
      SELECT count(*)::integer INTO v_live FROM entitlement."grant" g
       WHERE g."variantId" = p_variant_id AND g."status" IN ('pending', 'active', 'suspended');
      IF v_live + v."reservedCount" >= v."activeCap" THEN
        RETURN QUERY SELECT 'sold_out'::text, v."tenantId", v."salesCap", v."activeCap", v."soldCount", v."reservedCount";
        RETURN;
      END IF;
    END IF;
  END IF;

  -- The counts' CHECK (>= 0) refuses a give-back of what was never taken: a bug, never floored.
  RETURN QUERY
  UPDATE catalog.product_variant p
     SET "soldCount" = p."soldCount" + p_sold_delta,
         "reservedCount" = p."reservedCount" + p_reserved_delta
   WHERE p.id = p_variant_id
  RETURNING 'moved'::text, p."tenantId", p."salesCap", p."activeCap", p."soldCount", p."reservedCount";
END
$$;

REVOKE ALL ON FUNCTION catalog.move_variant_sales(uuid, integer, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.move_variant_sales(uuid, integer, integer, boolean) TO txnet_app;
