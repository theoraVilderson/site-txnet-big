-- F-204-a (D-63): a reseller brings its old panel's subscription host.
--
--   TenantDomainPurpose.legacy_sub — the host the old panel served its users'
--                       subscription links on (e.g. sub.ali-vpn.ir). Added,
--                       proved by TXT and pointed by CNAME at the reseller's
--                       edge target as any custom domain (F-018-i, F-018-ai);
--                       it serves sub-service's paths alone — the old links
--                       (F-203-b) and `/sub` — never the panel or the API.
--
-- Additive; rollback: none needed (Postgres cannot drop an enum value, and an
-- unused value is harmless).

ALTER TYPE "tenant"."TenantDomainPurpose" ADD VALUE 'legacy_sub';
