-- F-038-u (ADR-0109 point 15). The engine invites a user to the tenant's
-- wheel: it reads whether a version is in force (`spin_wheel_config`) and when
-- the user last won a spin (`spin_wheel_attempt`), each one tenant's rows. It
-- reads no prize and no odds: the wheel decides what, the engine who and when.
-- `USAGE ON SCHEMA engagement` is `20261003000900_ai_prize_inputs`'.
--
-- Additive. Rollback: DROP POLICY ai_reader on both; REVOKE the grants.

GRANT SELECT ON engagement.spin_wheel_config TO txnet_ai_reader;
CREATE POLICY ai_reader ON engagement.spin_wheel_config
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());

GRANT SELECT ON engagement.spin_wheel_attempt TO txnet_ai_reader;
CREATE POLICY ai_reader ON engagement.spin_wheel_attempt
  AS PERMISSIVE FOR SELECT TO txnet_ai_reader
  USING ("tenantId" = public.current_tenant_id());
