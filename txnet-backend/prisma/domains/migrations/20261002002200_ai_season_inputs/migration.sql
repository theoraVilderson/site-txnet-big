-- F-038-r (ADR-0109 point 15: seasons come from F-505-a, not a second
-- calendar). The decision pipeline reads the seasons' written campaigns on the
-- plans it names — what each plan will cost in which window, in its currency —
-- and the season's name for the reason. Shared-read, as the catalog's own
-- policy: the tenant's rows and the platform's.
--
-- Additive. Rollback: DROP POLICY ai_reader on both; REVOKE the grants.

GRANT SELECT ON catalog.price_campaign TO txnet_ai_reader;
CREATE POLICY ai_reader ON catalog.price_campaign
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id());

GRANT SELECT ON catalog.season TO txnet_ai_reader;
CREATE POLICY ai_reader ON catalog.season
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" IS NULL OR "tenantId" = public.current_tenant_id());
