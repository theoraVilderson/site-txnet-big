-- The gateway host is a door of its own: it answers the API like a panel
-- domain, but no link is ever built on it. Its own migration, because a new
-- enum value cannot be used in the transaction that adds it.
ALTER TYPE "tenant"."TenantDomainPurpose" ADD VALUE 'api';
