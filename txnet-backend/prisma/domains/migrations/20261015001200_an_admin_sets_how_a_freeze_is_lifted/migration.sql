-- F-0401-d — an admin freezes hard or soft, and may change the mode of a
-- frozen Grant (billing `contract.reseller-grants.md` "Freeze"). The change is
-- one `admin_audit_log` row; `freezeMode` itself is F-0401-a's column.
--
-- Additive; rollback: nothing to drop (Postgres cannot remove an enum value).

ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_freeze_mode_set';
