-- F-038-e (ADR-0109 point 8, ADR-0108): the decision pipeline schedules a
-- suggestion outside the user's quiet window. `notification.notification_preference`
-- is keyed by user with no `tenantId`, so — as `20261002000600_ai_quiet_down_inputs`
-- did for tickets — the reader gets a view that scopes it by the user's tenant
-- and carries only the window and its zone: not which notices they muted.
-- A null `timezone` is the user's resolved zone, which the reader resolves
-- from `identity.user` (column grant, `20261002000300`) and the tenant.
--
-- Additive. Rollback: DROP VIEW ai.reader_quiet_hours.

CREATE VIEW ai.reader_quiet_hours WITH (security_barrier) AS
  SELECT p."userId", p."quietStart", p."quietEnd", p."timezone"
  FROM notification.notification_preference p
  JOIN identity."user" u ON u."id" = p."userId"
  WHERE u."tenantId" = public.current_tenant_id()
    AND p."quietStart" IS NOT NULL
    AND p."quietEnd" IS NOT NULL;

REVOKE ALL ON ai.reader_quiet_hours FROM PUBLIC, txnet_app, txnet_cross_tenant;
GRANT SELECT ON ai.reader_quiet_hours TO txnet_ai_reader;
