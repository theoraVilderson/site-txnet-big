-- TZ-1-b (ADR-0108 point 2): a tenant has a time zone, and a user may.
-- `tenant.timezone` defaults to the platform constant (`PLATFORM_DEFAULT_TIMEZONE`
-- in shared-core), so every existing tenant reads exactly what it read before.
-- `user.timezone` is null for everyone: the resolver then reads the tenant's.
-- `timezoneSource` says whether the user chose the zone or the panel's browser
-- reported it, and exists exactly when the zone does.
--
-- Additive; rollback: drop the three columns, the CHECK and the type.

CREATE TYPE "identity"."TimeZoneSource" AS ENUM ('user', 'browser');

ALTER TABLE "identity"."user"
    ADD COLUMN "timezone" TEXT,
    ADD COLUMN "timezoneSource" "identity"."TimeZoneSource",
    ADD CONSTRAINT "user_timezone_has_a_source" CHECK (("timezone" IS NULL) = ("timezoneSource" IS NULL));

ALTER TABLE "tenant"."tenant" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Tehran';
