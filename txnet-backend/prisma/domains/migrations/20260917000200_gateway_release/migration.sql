-- F-102-f-b (D-37, ADR-0053 amendment) — deleting a gateway that other tenants
-- borrow, without the cross-tenant pool.
--
-- A tenant admin now manages its own gateways on the app pool, where strict RLS
-- on `payment_transaction` and `payment_gateway_grant` hides every row of a
-- borrowing tenant. Deleting a lent gateway needs exactly two things from those
-- rows, and nothing more:
--
--   1. `billing.gateway_usage` — how many payments ever named the gateway, how
--      many are still open (`pending`/`expired` inside the lookback: delete is
--      refused while any is), and how many grants were ever made — a withdrawn
--      one still blocks a hard delete (`Restrict`). Counts only.
--   2. `billing.withdraw_gateway_grants` — withdraw those grants (soft:
--      `isActive` false, `withdrawnAt`, `withdrawnByAdminId`) and write one
--      `gateway_grant_withdraw` audit row **in each borrower's tenant**, so the
--      borrower's own trail says why its gateway went away.
--
-- Both refuse unless the gateway is the caller's own: a `tenant_gateway_config`
-- whose `tenantId` is `current_tenant_id()`, or any gateway when the session
-- logged in through `txnet_cross_tenant` (the platform owner's pool). A platform
-- `payment_gateway` is the cross-tenant role's alone. SECURITY DEFINER for the
-- reason `billing.platform_coupon_serves` is (ADR-0040): the caller's own RLS
-- would hide the very rows the answer is about. `session_user`, not
-- `current_user`, names the caller — inside the function `current_user` is the
-- owner.
--
-- Rollback: DROP FUNCTION billing.withdraw_gateway_grants(text, uuid, uuid, text),
-- billing.gateway_usage(text, uuid, integer), billing.gateway_is_callers(text, uuid).

DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'gateway release functions need an owner that bypasses RLS; % does not', current_user;
  END IF;
END
$$;

-- Not granted to anyone: only the two functions below call it, as the owner.
CREATE FUNCTION billing.gateway_is_callers(p_source text, p_gateway_id uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN pg_has_role(session_user, 'txnet_cross_tenant', 'MEMBER') THEN p_source IN ('platform', 'tenant')
    WHEN p_source = 'tenant' THEN EXISTS (
      SELECT 1 FROM tenant.tenant_gateway_config
       WHERE id = p_gateway_id AND "tenantId" = public.current_tenant_id())
    ELSE false
  END
$$;
REVOKE ALL ON FUNCTION billing.gateway_is_callers(text, uuid) FROM PUBLIC;

CREATE FUNCTION billing.gateway_usage(p_source text, p_gateway_id uuid, p_open_within_sec integer)
  RETURNS TABLE (payments integer, open_payments integer, grants integer)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT billing.gateway_is_callers(p_source, p_gateway_id) THEN
    RAISE EXCEPTION 'gateway_not_callers' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    (SELECT count(*)::integer FROM billing.payment_transaction t
      WHERE (p_source = 'platform' AND t."gatewayId" = p_gateway_id)
         OR (p_source = 'tenant' AND t."tenantGatewayConfigId" = p_gateway_id)),
    (SELECT count(*)::integer FROM billing.payment_transaction t
      WHERE ((p_source = 'platform' AND t."gatewayId" = p_gateway_id)
          OR (p_source = 'tenant' AND t."tenantGatewayConfigId" = p_gateway_id))
        AND t.status IN ('pending', 'expired')
        AND t."createdAt" >= (now() AT TIME ZONE 'UTC') - make_interval(secs => p_open_within_sec)),
    (SELECT count(*)::integer FROM billing.payment_gateway_grant g
      WHERE (p_source = 'platform' AND g."gatewayId" = p_gateway_id)
         OR (p_source = 'tenant' AND g."tenantGatewayConfigId" = p_gateway_id));
END
$$;
REVOKE ALL ON FUNCTION billing.gateway_usage(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.gateway_usage(text, uuid, integer) TO txnet_app, txnet_cross_tenant;

CREATE FUNCTION billing.withdraw_gateway_grants(p_source text, p_gateway_id uuid, p_admin_id uuid, p_admin_ip text)
  RETURNS integer
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  withdrawn_count integer;
BEGIN
  IF NOT billing.gateway_is_callers(p_source, p_gateway_id) THEN
    RAISE EXCEPTION 'gateway_not_callers' USING ERRCODE = '42501';
  END IF;
  WITH withdrawn AS (
    UPDATE billing.payment_gateway_grant g
       SET "isActive" = false,
           "withdrawnAt" = now() AT TIME ZONE 'UTC',
           "withdrawnByAdminId" = p_admin_id
     WHERE g."isActive"
       AND ((p_source = 'platform' AND g."gatewayId" = p_gateway_id)
         OR (p_source = 'tenant' AND g."tenantGatewayConfigId" = p_gateway_id))
    RETURNING g.id, g."tenantId", g."withdrawnAt"
  ), audited AS (
    INSERT INTO audit.admin_audit_log
      (id, "tenantId", "adminId", action, "targetEntityType", "targetEntityId", "oldValue", "newValue", "adminIpAddress")
    SELECT gen_random_uuid(), w."tenantId", p_admin_id,
           'gateway_grant_withdraw'::audit."AdminAction", 'gateway_grant'::audit."AuditTargetType", w.id,
           jsonb_build_object('isActive', true),
           jsonb_build_object('isActive', false,
                              'withdrawnAt', to_char(w."withdrawnAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                              'reason', 'gateway_delete', 'source', p_source, 'gatewayId', p_gateway_id),
           p_admin_ip
      FROM withdrawn w
    RETURNING 1
  )
  SELECT count(*)::integer INTO withdrawn_count FROM audited;
  RETURN withdrawn_count;
END
$$;
REVOKE ALL ON FUNCTION billing.withdraw_gateway_grants(text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing.withdraw_gateway_grants(text, uuid, uuid, text) TO txnet_app, txnet_cross_tenant;
