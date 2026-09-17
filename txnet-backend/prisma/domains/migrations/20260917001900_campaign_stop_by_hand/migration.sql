-- F-018-x — the platform owner stops a tenant's sending campaigns by hand.
--
-- `POST /api/notifications/campaigns/tenants/:tenantId/stop` writes one audit
-- row against the tenant when it stopped something (ADR-0058 (5)).
--
-- Rollback: none needed; enum values stay (Postgres cannot drop one).

ALTER TYPE "audit"."AdminAction" ADD VALUE IF NOT EXISTS 'campaign_stop';
