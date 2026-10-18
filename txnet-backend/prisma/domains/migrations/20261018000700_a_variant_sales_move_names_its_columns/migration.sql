-- F-513-b: `catalog.move_variant_sales` (20261018000600) named its result
-- columns as the table's, so every unqualified "tenantId" in its body was
-- ambiguous and the first call raised. Same signature and result; every
-- column is read through the alias `p` now. No data is touched.

CREATE OR REPLACE FUNCTION catalog.move_variant_sales(
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

  SELECT p.* INTO v FROM catalog.product_variant p
   WHERE p.id = p_variant_id
     AND (p."tenantId" = v_tenant OR p."tenantId" = public.platform_tenant_id())
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
