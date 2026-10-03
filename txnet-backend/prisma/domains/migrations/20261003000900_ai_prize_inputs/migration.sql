-- F-038-y (ADR-0111 point 2, ADR-0110). The engine knows a prize: a wheel or
-- lottery prize just won holds the sale about its Grant, and an unused prize
-- coupon holds any offer coupon. The reader reads what the prize became — the
-- `reward_issue` row, its duration change (the end before it) and its quota
-- adjustment (the bytes) — each one tenant's rows. The coupon is
-- `billing.coupon`, already granted.
--
-- Additive. Rollback: DROP POLICY ai_reader on the three tables; REVOKE the
-- grants and USAGE ON SCHEMA engagement.

GRANT USAGE ON SCHEMA engagement TO txnet_ai_reader;

GRANT SELECT ON engagement.reward_issue TO txnet_ai_reader;
CREATE POLICY ai_reader ON engagement.reward_issue
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON entitlement.grant_duration_change TO txnet_ai_reader;
CREATE POLICY ai_reader ON entitlement.grant_duration_change
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON entitlement.quota_adjustment TO txnet_ai_reader;
CREATE POLICY ai_reader ON entitlement.quota_adjustment
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());
