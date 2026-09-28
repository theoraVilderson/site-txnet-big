-- F-116-h7, ADR-0099: a platform coupon or gift code serves the platform
-- owner's users and no reseller's. A reseller's users see its brand, not the
-- platform's, and a platform discount on a reseller's sale would be paid out of
-- the reseller's money whatever the gateway — a wallet-paid invoice has none.
--
-- ADR-0048 decision 2 (`coupon_tenant` naming served tenants) is withdrawn, so
-- its table goes. RLS on `billing.coupon`, `reserve_coupon` and
-- `redeem_gift_coupon` all ask this one function, which is the whole change.
CREATE OR REPLACE FUNCTION billing.platform_coupon_serves(p_coupon_id uuid, p_tenant_id uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_tenant_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM tenant.tenant
                  WHERE id = p_tenant_id AND "tenantType" = 'platform_owner')
$$;

-- Empty on every environment this was written against; a row here would name a
-- reseller the function above no longer serves.
DROP TABLE billing.coupon_tenant;
