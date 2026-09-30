-- F-118-w: a reseller whose billing wallet refuses a VPN block's wholesale leg
-- (F-118-n3) is told once per refusal spell that its users on platform panels
-- are cut. `unfundedNoticeAt` marks the spell: set by the refusal that tells,
-- only while null, and cleared by the next block this wallet funds on a group
-- holding a platform panel. Null is armed.
--
-- No backfill: no refusal was ever told. Additive; rollback: drop the column.

ALTER TABLE "tenant"."tenant_billing_wallet"
  ADD COLUMN "unfundedNoticeAt" TIMESTAMP(3);
