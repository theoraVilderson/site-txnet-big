-- F-027-bc — the two x-ui forks are two families, not one value.
--
-- `x_ui` named two products: the alireza0 fork, which publishes an API under
-- `/xui/API/inbounds`, and the original by vaxilu, which has none and is
-- driven through its web routes. The questionnaire's verdict is kept per
-- `driverType`, so one value could not carry the two different verdicts, and
-- guessing the fork on every open would switch drivers silently when a panel
-- was replaced (user, 2026-09-24).
--
-- `x_ui` is renamed, not dropped: no driver opened it, so a row carrying it
-- was registered for the fork the published API belongs to. Rollback: rename
-- back; the added value cannot be dropped from a Postgres enum, so a rollback
-- that must remove it recreates the type.

ALTER TYPE "network"."DriverType" RENAME VALUE 'x_ui' TO 'x_ui_alireza';
ALTER TYPE "network"."DriverType" ADD VALUE 'x_ui_vaxilu' AFTER 'x_ui_alireza';
