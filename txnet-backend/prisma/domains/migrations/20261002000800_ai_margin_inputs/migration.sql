-- F-038-p (ADR-0109 point 8): the decision pipeline ranks by margin, so it
-- reads what a reseller pays for a plan — the wholesale rate its Grant locked
-- (`entitlement.grant_wholesale`, F-118-p). SELECT only, under the same
-- tenant clause as the table's own app policy: a reseller's engine reads its
-- own Grants' legs and no other's.
--
-- Additive. Rollback: DROP POLICY ai_reader ON entitlement.grant_wholesale;
-- REVOKE SELECT ON entitlement.grant_wholesale FROM txnet_ai_reader.

GRANT SELECT ON entitlement.grant_wholesale TO txnet_ai_reader;
CREATE POLICY ai_reader ON entitlement.grant_wholesale
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());
