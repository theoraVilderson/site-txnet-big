-- F-514-a: a variant may cap its live services at once (catalog F-514).
--
-- 1. `activeCap` null = no cap. Beside F-513's `salesCap`; either full is sold
--    out. No CHECK ties it to the live count: an admin may lower it under what
--    is live (sales close, no service ends — user, 2026-10-18).
-- 2. The live count is never stored: it is the variant's Grants that are
--    `pending`, `active` or `suspended`, counted by `catalog.live_grants_of`.
--    A counter would have to be moved by every status writer; the grants
--    cannot disagree with themselves.
-- 3. The function is SECURITY DEFINER because a platform variant's grants
--    belong to every reseller, and RLS shows the caller only its own. It
--    answers counts only, and only for variants the bound tenant can see (its
--    own or the platform's), as RLS would read them.
-- 4. The partial index is what the count scans: live grants by variant.
-- Additive; rollback: drop the function, the index and the column.

DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'live_grants_of needs an owner that bypasses RLS; % does not', current_user;
  END IF;
END
$$;

ALTER TABLE "catalog"."product_variant"
    ADD COLUMN "activeCap" INTEGER,
    ADD CONSTRAINT "product_variant_active_cap_positive" CHECK ("activeCap" IS NULL OR "activeCap" > 0);

CREATE INDEX "grant_variant_live_idx" ON "entitlement"."grant"("variantId")
    WHERE "status" IN ('pending', 'active', 'suspended');

-- One row per requested variant the bound tenant can see, with its live
-- Grants across every tenant; a variant it cannot see is left out.
CREATE FUNCTION catalog.live_grants_of(p_variant_ids uuid[])
  RETURNS TABLE ("variantId" uuid, "liveCount" integer)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'live_grants_of: no tenant bound on this transaction';
  END IF;
  RETURN QUERY
  SELECT p.id,
         (SELECT count(*)::integer FROM entitlement."grant" g
           WHERE g."variantId" = p.id AND g."status" IN ('pending', 'active', 'suspended'))
    FROM catalog.product_variant p
   WHERE p.id = ANY (p_variant_ids)
     AND (p."tenantId" = v_tenant OR p."tenantId" = public.platform_tenant_id());
END
$$;

REVOKE ALL ON FUNCTION catalog.live_grants_of(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.live_grants_of(uuid[]) TO txnet_app;
