-- The platform's `api.<domain>` was seeded as a `panel` row, so `panelHostOf`
-- (alphabetical among subdomains) sent "open your service", payment returns and
-- logo links to the API host instead of `panel.<domain>`. Re-purposed in place:
-- tenant resolution on that host is unchanged, it only stops being a link target.
UPDATE "tenant"."tenant_domain" d
SET "purpose" = 'api'
FROM "tenant"."tenant" t
WHERE t."id" = d."tenantId"
  AND t."tenantType" = 'platform_owner'
  AND d."domainType" = 'subdomain'
  AND d."purpose" = 'panel'
  AND d."domainValue" LIKE 'api.%';
