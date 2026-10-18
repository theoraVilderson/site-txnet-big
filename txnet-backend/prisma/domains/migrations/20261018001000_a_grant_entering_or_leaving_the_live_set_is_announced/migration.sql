-- F-514-c: a Grant entering or leaving the live set of a variant with an
-- active cap writes `catalog.variant.sales_changed`, so an open shop re-reads
-- "available again" (catalog F-514, C-14, RT-1-p).
--
-- 1. A trigger, not a call in each writer (user, 2026-10-18): a Grant's status
--    is moved by billing, entitlement's sweeps, the reseller's admin, bulk jobs
--    and the Go collector, and `entitlement.grant` is the one row all of them
--    write. Live = `pending`, `active`, `suspended` (contract.sales-cap.md A1);
--    a move inside the set (pending -> active, active -> suspended) changes no
--    count and announces nothing.
-- 2. The same event, payload and channel as `moveSales` (sales-counts.ts):
--    `{catalogId, tenantId, variantId}` on the variant owner's catalog,
--    `platform` for the platform's — one row however many resellers sell it.
--    Only a variant with `activeCap`: an uncapped one shows nothing as left,
--    and a sales cap's remainder does not move with the live set.
-- 3. At most one event per variant per transaction: the page re-reads after
--    the commit, so a bulk job expiring 5 000 Grants of one variant writes one
--    row, not 5 000. The variants already announced are kept in a setting
--    local to the transaction (C-41), never in a table.
-- 4. SECURITY DEFINER: the writer may be a reseller's transaction, whose RLS
--    shows the platform's variant but whose role is not the outbox's owner,
--    or a cross-tenant sweep with no tenant bound. It reads one variant row
--    and inserts one outbox row, and nothing else.
-- `requestId` stays null: a trigger cannot see the request (H13).
-- No data is touched. Rollback: drop the trigger and the function.

DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'announce_live_grant_change needs an owner that bypasses RLS; % does not', current_user;
  END IF;
END
$$;

CREATE FUNCTION catalog.announce_live_grant_change() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_was uuid;
  v_now uuid;
  v_variant uuid;
  v_owner uuid;
  v_announced text;
BEGIN
  -- The variant a live Grant counted against before the change, and after it.
  IF TG_OP <> 'INSERT' AND OLD."status" IN ('pending', 'active', 'suspended') THEN
    v_was := OLD."variantId";
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."status" IN ('pending', 'active', 'suspended') THEN
    v_now := NEW."variantId";
  END IF;
  IF v_was IS NOT DISTINCT FROM v_now THEN
    RETURN NULL;
  END IF;

  FOREACH v_variant IN ARRAY ARRAY[v_was, v_now] LOOP
    CONTINUE WHEN v_variant IS NULL;
    v_announced := coalesce(current_setting('catalog.live_announced', true), '');
    CONTINUE WHEN position(v_variant::text IN v_announced) > 0;

    SELECT p."tenantId" INTO v_owner FROM catalog.product_variant p
     WHERE p.id = v_variant AND p."activeCap" IS NOT NULL;
    CONTINUE WHEN v_owner IS NULL;

    INSERT INTO automation.outbox_event (id, aggregate, "aggregateId", type, payload)
    VALUES (
      gen_random_uuid(),
      'catalog.variant',
      v_variant::text,
      'catalog.variant.sales_changed',
      jsonb_build_object(
        'catalogId', CASE WHEN v_owner = public.platform_tenant_id() THEN 'platform' ELSE v_owner::text END,
        'tenantId', v_owner,
        'variantId', v_variant
      )
    );
    PERFORM set_config('catalog.live_announced', v_announced || v_variant::text || ',', true);
  END LOOP;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION catalog.announce_live_grant_change() FROM PUBLIC;

CREATE TRIGGER grant_live_set_announced
  AFTER INSERT OR UPDATE OF "status", "variantId" OR DELETE ON entitlement."grant"
  FOR EACH ROW EXECUTE FUNCTION catalog.announce_live_grant_change();
