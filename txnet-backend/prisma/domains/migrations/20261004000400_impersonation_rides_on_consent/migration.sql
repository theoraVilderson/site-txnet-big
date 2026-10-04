-- F-117-e (ADR-0104 (4)(5), catalog §3.6 layer 6) — platform staff impersonate
-- a reseller's user only under its `act` consent or their own emergency entry.
-- The impersonation records which of the two admitted it, so revoking the
-- consent or ending the entry ends the session at once. No `tenantId`: the
-- table stays the platform's record (no RLS); the reseller's own log holds the
-- start's audit row.
--
-- Additive (two nullable columns, two indexes). Rollback: DROP them.

ALTER TABLE "audit"."impersonation_session"
  ADD COLUMN "consentId" UUID,
  ADD COLUMN "emergencyEntryId" UUID;

CREATE INDEX "impersonation_session_consentId_idx" ON "audit"."impersonation_session"("consentId");
CREATE INDEX "impersonation_session_emergencyEntryId_idx" ON "audit"."impersonation_session"("emergencyEntryId");
