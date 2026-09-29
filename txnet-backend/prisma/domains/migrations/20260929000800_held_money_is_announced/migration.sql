-- F-118-o: a hold or a release announces `billing.wallet.changed`, at most once
-- per 30 s per wallet. `heldPushedAt` is the slot the announcing transaction
-- claims on the wallet row it already holds locked. Nullable, no default: every
-- existing wallet has never announced a hold.
--
-- Not in `wallet_matches_holds`'s column list, so claiming it fires no trigger.
--
-- Rollback: ALTER TABLE "billing"."wallet" DROP COLUMN "heldPushedAt";

ALTER TABLE "billing"."wallet" ADD COLUMN "heldPushedAt" TIMESTAMP(3);
