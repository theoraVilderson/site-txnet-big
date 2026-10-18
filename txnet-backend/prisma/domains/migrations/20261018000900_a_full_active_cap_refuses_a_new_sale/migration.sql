-- F-514-b: a variant's sales move refuses a new sale when its active cap is
-- full (catalog F-514), under the same row lock F-513-b's sales cap is held by.
--
-- 1. Full = live Grants (`pending`, `active`, `suspended`, every tenant) plus
--    the pending invoices' holds >= `activeCap`. Only a move that takes a unit
--    and already refuses — an invoice's hold, a free path's sale — is refused;
--    a hold becoming a sale, staff's issue and every give-back never are. A
--    renewal is the same Grant (F-027-dg) and calls no move at all.
-- 2. The live count is its own statement, after the FOR UPDATE: this function
--    is VOLATILE and the transaction READ COMMITTED, so the count takes a new
--    snapshot once the lock is held. A payment that held the lock commits its
--    hold's release and its Grant together; a buyer queued behind it then sees
--    the Grant, never the freed hold without it. Counted inside the lock's
--    statement, the snapshot would predate the payment and give its slot twice.
-- 3. The result names `activeCap` too, so a move of a variant capped only by
--    its live services is announced (C-14). A new result column cannot be
--    added by CREATE OR REPLACE; the drop and the create are one transaction,
--    and the old caller's named columns are all still answered.
-- No data is touched. Rollback: re-create 20261018000700's function.

DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'move_variant_sales needs an owner that bypasses RLS; % does not', current_user;
  END IF;
END
$$;

DROP FUNCTION catalog.move_variant_sales(uuid, integer, integer, boolean);

CREATE FUNCTION catalog.move_variant_sales(
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
     FOR UPDATE;
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
      -- Its own statement, so its snapshot is taken under the lock (header, 2).
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
