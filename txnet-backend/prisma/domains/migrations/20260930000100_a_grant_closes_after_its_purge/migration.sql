-- F-118-x (D-59 (b)): the close stage after the purge. A suspended Grant past
-- its purge window plus its close window is `expired` and its money settled.
-- The window is its own setting, per tenant with a per-Grant override, like
-- the purge's (ADR-0075); `0` = never.
--
-- Rollback: drop both columns and their checks.

ALTER TABLE "tenant"."tenant"
    ADD COLUMN "closeAfterDays" INTEGER NOT NULL DEFAULT 30,
    ADD CONSTRAINT "tenant_close_days_not_negative" CHECK ("closeAfterDays" >= 0);

ALTER TABLE "entitlement"."grant"
    ADD COLUMN "closeAfterDays" INTEGER,
    ADD CONSTRAINT "grant_close_days_not_negative" CHECK (
        "closeAfterDays" IS NULL OR "closeAfterDays" >= 0);
