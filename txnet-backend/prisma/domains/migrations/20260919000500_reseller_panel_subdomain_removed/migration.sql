-- ADR-0063 — a reseller has one platform-issued host, its CNAME target.
--
-- Until now a reseller was created with two `subdomain` rows: `<slug>.<domain>`
-- (a panel host on the platform's name) and `<slug>.edge.<domain>` (the target
-- its own domain is CNAMEd to, ADR-0060 (6)). The first is removed: a platform
-- name a reseller can use is one it can hand its customers, and a filter on
-- the platform's name then takes every reseller down together (D-01). New
-- resellers get the target only (`resellerHosts`); this removes the rows the
-- old code wrote.
--
-- Only a reseller's `panel` subdomain whose second label is not `edge` goes.
-- The platform owner's own hosts (`panel.<domain>`, `api.<domain>`) belong to
-- the `platform_owner` tenant and are untouched; custom domains, and any
-- `subscription` / `assets` row, are untouched.
--
-- The `tenant_domain` trigger of 20260919000400 notifies on DELETE, so each
-- affected tenant's `tenant:status` is recomputed. `tenant:host:<host>` entries
-- are not reachable from SQL: a removed host keeps resolving from the cache
-- until `RedisTtl.tenantResolution` (600 s) runs out.
--
-- Rollback: not automatic — the rows carried no data beyond the host, and
-- `resellerHosts` no longer writes them. Recreate by hand if ever needed.

DELETE FROM "tenant"."tenant_domain" AS d
USING "tenant"."tenant" AS t
WHERE d."tenantId" = t."id"
  AND t."tenantType" = 'reseller'
  AND d."domainType" = 'subdomain'
  AND d."purpose" = 'panel'
  AND split_part(d."domainValue", '.', 2) <> 'edge';
