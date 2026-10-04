-- F-117-c (ADR-0104 (6), D-57) — every request the platform's staff make among
-- a reseller's people, reads included, is one `admin_audit_log` row in that
-- reseller's trail: action `platform_access`, target the reseller, `newValue`
-- {tier, consentId, scope, capability, act, target}. Written by the door.
--
-- Additive. Rollback: none needed; the value is inert once nothing writes it.

ALTER TYPE "audit"."AdminAction" ADD VALUE 'platform_access';
