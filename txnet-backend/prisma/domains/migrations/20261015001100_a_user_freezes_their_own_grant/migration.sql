-- F-0401-c — the user freezes and unfreezes their own metered Grant (billing
-- `contract.gift.md` "Self-freeze"). Each act is one `admin_audit_log` row with
-- the user as its actor; at most 3 freezes per Grant in any 24 hours are
-- counted from these rows, on the existing (targetEntityId, createdAt) index.
--
-- Additive; rollback: nothing to drop (Postgres cannot remove an enum value).

ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_self_freeze';
ALTER TYPE "audit"."AdminAction" ADD VALUE 'grant_self_unfreeze';
